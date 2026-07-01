from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import re
from datetime import date as date_, datetime, timezone

from typing import TYPE_CHECKING

from ib_async import IB, Contract, Order

from models.broker_session import BrokerSessionMode
from models.tws_order_capabilities import can_modify_order_type
from services.tws_order_packages import derive_package_warnings

if TYPE_CHECKING:
    from models.execution_plan import ExecutionPlan
from models.tws_execution_assistant import (
    BarSnapshot,
    BarsResponse,
    InstrumentResult,
    OrderSnapshot,
    PAPER_PORTS,
    PaperOrderSubmission,
    PositionSnapshot,
    QuoteSnapshot,
    ReconciliationSnapshot,
    ReconciliationSummary,
    TwsAdapterState,
    TwsAdvancedReject,
    TwsModifyOrderRequest,
    TwsOrderActionResult,
    TwsOrderPackageLegSubmission,
    TwsOrderPackagePreview,
    TwsOrderPackageSubmission,
    TwsStatusResponse,
)

log = logging.getLogger(__name__)


class TwsPlaceOrderGuardError(Exception):
    """Raised before placeOrder() when a pre-submit guard fails deterministically.

    The order was never sent to TWS — the outcome is not ambiguous.
    error_code matches Orbit's typed error vocabulary for the router to map.
    """

    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


class TwsAdvancedRejectError(Exception):
    """Raised when TWS returns an overridable advanced reject during placeOrder."""

    def __init__(self, reject: TwsAdvancedReject) -> None:
        super().__init__(reject.reason)
        self.reject = reject


# TWS error codes that carry overridable advanced reject payloads.
_ADVANCED_REJECT_CODES: frozenset[int] = frozenset({399, 201})


def _advanced_reject_from_raw(order_id: int | None, raw: str) -> TwsAdvancedReject:
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return TwsAdvancedReject(order_id=order_id, reason="TWS rejected the order.", override_codes=[], raw=raw)

    codes: list[str] = []
    if isinstance(parsed, dict):
        for key in ("8229", "errorCode", "code", "override", "overrideCode"):
            value = parsed.get(key)
            if isinstance(value, str) and value:
                codes.extend(part.strip() for part in value.split(",") if part.strip())
        reason = str(
            parsed.get("message") or parsed.get("errorMsg") or parsed.get("reason")
            or "TWS rejected the order."
        )
        return TwsAdvancedReject(
            order_id=order_id, reason=reason, override_codes=sorted(set(codes)), raw=parsed
        )
    return TwsAdvancedReject(order_id=order_id, reason="TWS rejected the order.", override_codes=[], raw=raw)

_IBKR_UNSET = 1.7976931348623157e+308
_MDT_MAP: dict[int, str] = {1: "live", 2: "frozen", 3: "delayed", 4: "delayed_frozen"}

# IBKR codes that are expected market-data permission responses, not real errors.
# 10089: no live subscription, delayed data may be available.
# 10090: partial subscription.
_EXPECTED_MDT_ERRORS: frozenset[int] = frozenset({10089, 10090})

_ib_log = logging.getLogger("ib_async")


_EXPECTED_MDT_PATTERN = re.compile(
    r"\b(" + "|".join(str(c) for c in _EXPECTED_MDT_ERRORS) + r")\b"
)


class _SuppressExpectedMdtWarnings(logging.Filter):
    """Downgrades expected IBKR market-data permission log lines to DEBUG.

    Attached to the ib_async logger only during get_quote(); removed in finally
    so unrelated ib_async warnings are never silenced.
    Uses a word-boundary pattern so a conid like 100890 is not a false match.
    """
    def filter(self, record: logging.LogRecord) -> bool:
        if _EXPECTED_MDT_PATTERN.search(record.getMessage()):
            record.levelno = logging.DEBUG
            record.levelname = "DEBUG"
        return True


def _quote_val(val: object) -> float | None:
    """Map IBKR nan / unset sentinel / None to Python None."""
    if val is None:
        return None
    try:
        f = float(val)  # type: ignore[arg-type]
        return None if (math.isnan(f) or f >= _IBKR_UNSET) else f
    except (TypeError, ValueError):
        return None


def _lmt_price(val: float) -> float | None:
    return val if val and 0 < val < _IBKR_UNSET else None


def _order_stop_price(order: Order) -> float | None:
    return _lmt_price(getattr(order, "auxPrice", None))


def _order_parent_id(order: Order) -> int | None:
    return order.parentId or None


def _order_oca_group(order: Order) -> str | None:
    return order.ocaGroup or None


def _order_ref(order: Order) -> str | None:
    return order.orderRef or None


def _apply_plan_prices(order: Order, plan: "ExecutionPlan") -> None:
    if plan.order_type in ("LMT", "STP LMT") and plan.limit_price is not None:
        order.lmtPrice = plan.limit_price
    if plan.order_type in ("STP", "STP LMT") and plan.stop_price is not None:
        order.auxPrice = plan.stop_price


class TwsBrokerAdapter:
    """Owns the ib_async IB connection. No ib_async types may leak beyond this class."""

    def __init__(self) -> None:
        self._ib = IB()
        self._state: TwsAdapterState = "not_initialized"
        self._client_id: int = 1
        self._last_host: str = "127.0.0.1"
        self._connected_port: int | None = None
        self._kill_switch_active: bool = False

    async def connect(self, host: str, port: int, client_id: int) -> None:
        # KNOWN GAP: no paper/live account-type check here. Paper is the default
        # port convention only, not enforced. Must be closed at the Slice 7 HITL
        # gate before any order-submission path exists.
        self._state = "connecting"
        self._client_id = client_id
        self._last_host = host
        self._connected_port = None
        try:
            await self._ib.connectAsync(host, port, clientId=client_id, timeout=10)
            await self._ib.reqPositionsAsync()
            await self._ib.reqAllOpenOrdersAsync()
            self._connected_port = port
            self._state = "connected"
        except (ConnectionRefusedError, asyncio.TimeoutError, OSError, RuntimeError) as exc:
            # ponytail: covers the known ib_async connect-time exceptions; client-ID
            # conflict arrives as an error callback, not an exception — it surfaces
            # as a dropped connection visible on the next status poll.
            log.warning("TWS connect failed (%s:%s cid=%s): %s", host, port, client_id, exc)
            self._state = "error"

    async def disconnect(self) -> None:
        if self._state == "not_initialized":
            return
        if self._ib.isConnected():
            self._ib.disconnect()
        self._state = "disconnected"

    def is_connected(self) -> bool:
        return self._state == "connected" and self._ib.isConnected()

    def is_paper_port(self) -> bool:
        """Fail-closed paper gate: True only for ports 4002 and 7497."""
        return self._connected_port in PAPER_PORTS

    def is_kill_switch_active(self) -> bool:
        return self._kill_switch_active

    def connected_host(self) -> str:
        return self._last_host

    def connected_port(self) -> int | None:
        return self._connected_port

    def connected_account_id(self) -> str | None:
        if not self.is_connected():
            return None
        accounts = self._ib.managedAccounts()
        return accounts[0] if accounts else None

    async def check_api_server(self) -> bool:
        """Return True if the TWS / IB Gateway API socket is TCP-reachable.

        Short-circuits to True when Orbit's adapter is already connected.
        Otherwise probes the last-used host (default 127.0.0.1) on IB Gateway
        paper port 4002 and TWS paper port 7497 with a 0.5 s timeout each.
        No IB API handshake is performed — just a raw TCP connect/close.
        """
        if self.is_connected():
            return True
        for port in (4002, 7497):
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection(self._last_host, port), timeout=0.5
                )
                writer.close()
                await writer.wait_closed()
                return True
            except (OSError, asyncio.TimeoutError):
                continue
        return False

    def get_status(self, mode: BrokerSessionMode, api_server_available: bool = False) -> TwsStatusResponse:
        connected = self._state == "connected" and self._ib.isConnected()
        if connected:
            trades = self._ib.openTrades()
            summary = ReconciliationSummary(
                position_count=len(self._ib.positions()),
                open_order_count=len(trades),
                unmanaged_order_count=sum(1 for t in trades if t.order.clientId != self._client_id),
            )
        else:
            summary = ReconciliationSummary()
        return TwsStatusResponse(
            mode=mode,
            connected=connected,
            adapter_state=self._state,
            kill_switch_active=self._kill_switch_active,
            reconciliation_summary=summary,
            api_server_available=api_server_available,
        )

    async def get_sec_type(self, conid: int) -> str | None:
        """Returns IBKR secType for a conid, or None if not connected or not found.

        Calls ib_async directly rather than routing through InstrumentIdentityService,
        which is a Client Portal / SQLite cache pattern and does not apply in TWS mode.
        This is the correct routing for TWS-context instrument lookup (approved decision).
        """
        if not self._ib.isConnected():
            return None
        try:
            details = await self._ib.reqContractDetailsAsync(Contract(conId=conid))
        except (RuntimeError, OSError) as exc:
            log.warning("Contract lookup failed for conid %s: %s", conid, exc)
            return None
        return details[0].contract.secType if details else None

    async def search_instruments(self, symbol: str) -> list[InstrumentResult]:
        """Lookup contracts by symbol.

        Tries STK/SMART/USD first; falls back to unconstrained symbol search.
        Returns results sorted with STK SMART USD first.
        Read-only — no orders, no account data, no connections beyond contract details.
        """
        if not self._ib.isConnected():
            return []
        try:
            details = await self._ib.reqContractDetailsAsync(
                Contract(symbol=symbol, secType="STK", exchange="SMART", currency="USD")
            )
            if not details:
                details = await self._ib.reqContractDetailsAsync(Contract(symbol=symbol))
        except (RuntimeError, OSError) as exc:
            log.warning("Instrument search failed for %s: %s", symbol, exc)
            return []

        results = [
            InstrumentResult(
                conid=d.contract.conId,
                symbol=d.contract.symbol,
                sec_type=d.contract.secType,
                exchange=d.contract.exchange,
                primary_exchange=getattr(d.contract, "primaryExchange", "") or "",
                currency=d.contract.currency,
                local_symbol=d.contract.localSymbol or d.contract.symbol,
            )
            for d in details
        ]
        # STK SMART USD to the front — those are the most useful for equity drafts
        results.sort(key=lambda r: (
            0 if (r.sec_type == "STK" and r.exchange == "SMART" and r.currency == "USD") else 1
        ))
        return results

    async def get_quote(self, conid: int) -> QuoteSnapshot:
        """Fetch a best-effort market data snapshot for a conid.

        Requests delayed-frozen data first so closed-market snapshots are
        available even when live bid/ask is absent. Classifies the response
        by IBKR market data type and surfaces error 10089 as a structured
        unavailable result rather than an indistinguishable all-null snapshot.

        Read-only — no streaming subscription persists after this call.
        """
        if not self._ib.isConnected():
            return QuoteSnapshot()

        captured_errors: list[int] = []

        def _on_error(req_id: int, code: int, msg: str, contract: object) -> None:
            # ponytail: req_id ignored — safe today (React Query single-flights per conid),
            # filter by req_id if concurrent quote calls are ever added.
            captured_errors.append(code)

        _mdt_filter = _SuppressExpectedMdtWarnings()
        self._ib.errorEvent += _on_error
        _ib_log.addFilter(_mdt_filter)
        try:
            # Request delayed-frozen before snapshot so IBKR returns the most
            # recent available quote even when live data is unavailable.
            self._ib.reqMarketDataType(4)
            # IBKR requires exchange identity for market data (Warning 321).
            # Supplying SMART/STK/USD is enough for equities — IBKR routes SMART
            # to the correct primary exchange for the given conid.
            contract = Contract(conId=conid, secType="STK", exchange="SMART", currency="USD")
            try:
                tickers = await asyncio.wait_for(
                    self._ib.reqTickersAsync(contract), timeout=5.0
                )
            except (RuntimeError, OSError, asyncio.TimeoutError) as exc:
                log.warning("Quote fetch failed for conid %s: %s", conid, exc)
                return QuoteSnapshot()

            if not tickers:
                return QuoteSnapshot(
                    market_data_type="unavailable",
                    unavailable_reason="Market data unavailable.",
                )

            t = tickers[0]
            # Cancel the subscription immediately — we only wanted a snapshot.
            self._ib.cancelMktData(t.contract)

            vals = (
                _quote_val(t.last), _quote_val(t.close), _quote_val(t.open),
                _quote_val(t.high), _quote_val(t.low), _quote_val(t.bid), _quote_val(t.ask),
            )
            # Check data before errors: reqMarketDataType(4) causes IBKR to fire
            # 10089 as an informational warning and then still return delayed data.
            # If the ticker has values, return them regardless of the warning.
            if any(v is not None for v in vals):
                # ponytail: marketDataType may be 0 even when delayed values arrive,
                # giving market_data_type="unknown" and "-" in Session Health while
                # prices are visible. Display-only inconsistency; fix if ib_async
                # reliably populates the field in practice.
                mdt = _MDT_MAP.get(getattr(t, "marketDataType", 0) or 0, "unknown")
                return QuoteSnapshot(
                    last=vals[0], close=vals[1], open=vals[2], high=vals[3],
                    low=vals[4], bid=vals[5], ask=vals[6],
                    market_data_type=mdt,
                    is_delayed=mdt in ("delayed", "delayed_frozen"),
                )

            if 10089 in captured_errors:
                return QuoteSnapshot(
                    market_data_type="unavailable",
                    is_delayed=False,
                    error_code=10089,
                    unavailable_reason="API market data subscription required; delayed market data may be available.",
                )

            return QuoteSnapshot(
                market_data_type="unavailable",
                unavailable_reason="Market data unavailable.",
            )
        finally:
            self._ib.errorEvent -= _on_error
            _ib_log.removeFilter(_mdt_filter)

    def get_reconciliation(self) -> ReconciliationSnapshot:
        if not self._ib.isConnected():
            return ReconciliationSnapshot()

        positions = [
            PositionSnapshot(
                conid=p.contract.conId,
                symbol=p.contract.symbol,
                position=p.position,
                avg_cost=p.avgCost,
            )
            for p in self._ib.positions()
        ]

        open_orders = [
            OrderSnapshot(
                order_id=t.order.orderId,
                conid=t.contract.conId,
                symbol=t.contract.symbol or t.contract.localSymbol or str(t.contract.conId),
                side=t.order.action,
                quantity=float(t.order.totalQuantity),
                order_type=t.order.orderType,
                lmt_price=_lmt_price(t.order.lmtPrice),
                stop_price=_order_stop_price(t.order),
                status=t.orderStatus.status,
                is_unmanaged=t.order.clientId != self._client_id,
                parent_id=_order_parent_id(t.order),
                oca_group=_order_oca_group(t.order),
                order_ref=_order_ref(t.order),
            )
            for t in self._ib.openTrades()
        ]

        return ReconciliationSnapshot(
            position_count=len(positions),
            open_order_count=len(open_orders),
            unmanaged_order_count=sum(1 for o in open_orders if o.is_unmanaged),
            positions=positions,
            open_orders=open_orders,
            package_warnings=derive_package_warnings(open_orders, positions),
        )

    async def place_order(
        self,
        plan: "ExecutionPlan",
        *,
        mode: str,
        live_policy: object | None = None,
        advanced_override: list[str] | None = None,
    ) -> PaperOrderSubmission:
        """Submit an order to TWS for a validated plan.

        Re-verifies all execution gates before calling placeOrder() — defense-in-depth
        in case the router check and this call are separated by a race or refactor.
        placeOrder() is synchronous; fill confirmation arrives asynchronously via
        TWS callbacks (visible through reconciliation).

        Awaits 300 ms after placeOrder() to capture any immediate TWS advanced rejects
        before returning. If TWS fires an overridable error, raises TwsAdvancedRejectError
        so the caller can surface the reject payload and prompt the user to override.
        Pass advanced_override codes (from a prior reject) to resubmit with override.
        """
        if self._kill_switch_active:
            raise TwsPlaceOrderGuardError("kill_switch_active")
        if not self.is_connected():
            raise TwsPlaceOrderGuardError("not_connected")
        if mode == "paper":
            if not self.is_paper_port():
                raise TwsPlaceOrderGuardError("not_paper_port")
        elif mode == "live":
            if live_policy is None:
                raise TwsPlaceOrderGuardError("live_session_not_armed")
            live_policy.assert_live_allowed(  # type: ignore[union-attr]
                account_id=self.connected_account_id(),
                host=self.connected_host(),
                port=self.connected_port(),
                is_connected=self.is_connected(),
                is_paper_port=self.is_paper_port(),
            )
        else:
            raise TwsPlaceOrderGuardError("unsupported_execution_mode")
        if plan.status != "valid":
            raise TwsPlaceOrderGuardError("plan_not_valid")

        contract = Contract(conId=plan.conid, symbol=plan.symbol, secType="STK", exchange="SMART", currency="USD")
        order = Order(
            action=plan.side,
            orderType=plan.order_type,
            totalQuantity=plan.quantity,
            tif="DAY",
        )
        _apply_plan_prices(order, plan)
        if advanced_override:
            order.advancedErrorOverride = ",".join(advanced_override)

        captured_rejects: list[TwsAdvancedReject] = []

        def _on_error(req_id: int, code: int, msg: str, contract: object) -> None:
            if code in _ADVANCED_REJECT_CODES and msg:
                captured_rejects.append(_advanced_reject_from_raw(None, msg))

        # Statuses that mean TWS accepted the order — any captured 399 was informational.
        _ACCEPTED: frozenset[str] = frozenset({"PreSubmitted", "Submitted", "Filled", "PartiallyFilled"})

        self._ib.errorEvent += _on_error
        try:
            trade = self._ib.placeOrder(contract, order)
            # Wait briefly for TWS to fire any immediate advanced reject errors.
            await asyncio.sleep(0.3)
            if captured_rejects and trade.orderStatus.status not in _ACCEPTED:
                raise TwsAdvancedRejectError(captured_rejects[0])
        finally:
            self._ib.errorEvent -= _on_error

        # trade.orderStatus.status is typically "" immediately after placeOrder —
        # the real status arrives asynchronously via TWS callbacks.
        broker_status = trade.orderStatus.status or "sent_to_tws"
        return PaperOrderSubmission(
            order_id=trade.order.orderId,
            status=broker_status,
            plan_id=plan.plan_id,
            conid=plan.conid,
            symbol=plan.symbol,
            side=plan.side,
            quantity=plan.quantity,
            order_type=plan.order_type,
            limit_price=plan.limit_price,
            stop_price=plan.stop_price,
            submitted_at=datetime.now(timezone.utc),
        )

    async def place_paper_order(
        self,
        plan: "ExecutionPlan",
        advanced_override: list[str] | None = None,
    ) -> PaperOrderSubmission:
        return await self.place_order(plan, mode="paper", advanced_override=advanced_override)

    async def place_order_package(
        self,
        preview: TwsOrderPackagePreview,
        *,
        mode: str,
        live_policy: object | None = None,
        advanced_override: list[str] | None = None,
    ) -> TwsOrderPackageSubmission:
        """Submit a previously previewed order package (e.g. a scale-out ladder).

        Re-runs the same defense-in-depth guard as place_order before building any
        order. Generates every leg's orderId up front via getReqId() so each child
        can carry a valid parentId — mirrors ib_async's own IB.bracketOrder()
        pattern. A package may contain multiple independent parent legs (e.g. one
        per scale-out lot); each child's parentId is resolved by role, never a
        single shared root, since TWS auto-links every order sharing one parentId
        into one OCA-managed cohort regardless of any custom ocaGroup — sharing a
        root across lots would silently merge their otherwise-isolated exits.
        Legs are placed in preview order with transmit=False on every leg except
        the very last, so TWS does not route a partial package.
        """
        self._ensure_order_mutation_allowed(mode=mode, live_policy=live_policy)

        contract = Contract(
            conId=preview.conid, symbol=preview.symbol, secType="STK", exchange="SMART", currency="USD"
        )
        order_ids = [self._ib.client.getReqId() for _ in preview.legs]
        order_id_by_role = {leg.role: order_ids[i] for i, leg in enumerate(preview.legs)}

        captured_rejects: list[TwsAdvancedReject] = []

        def _on_error(req_id: int, code: int, msg: str, contract: object) -> None:
            if code in _ADVANCED_REJECT_CODES and msg:
                captured_rejects.append(_advanced_reject_from_raw(req_id, msg))

        _ACCEPTED: frozenset[str] = frozenset({"PreSubmitted", "Submitted", "Filled", "PartiallyFilled"})

        trades = []
        self._ib.errorEvent += _on_error
        try:
            for i, leg in enumerate(preview.legs):
                order = Order(
                    orderId=order_ids[i],
                    action=leg.side,
                    orderType=leg.order_type,
                    totalQuantity=leg.quantity,
                    tif=leg.tif,
                    transmit=leg.transmit,
                    orderRef=f"ORBIT:TWS:{preview.package_id}:{leg.role}",
                )
                if leg.limit_price is not None:
                    order.lmtPrice = leg.limit_price
                if leg.stop_price is not None:
                    order.auxPrice = leg.stop_price
                if leg.trail is not None:
                    if leg.trail.mode == "percent":
                        order.trailingPercent = leg.trail.value
                    else:
                        order.auxPrice = leg.trail.value
                if leg.limit_offset is not None:
                    order.lmtPriceOffset = leg.limit_offset
                if leg.good_till_date is not None:
                    order.goodTillDate = leg.good_till_date
                if leg.parent_ref is not None:
                    order.parentId = order_id_by_role[leg.parent_ref]
                if leg.oca_group is not None:
                    order.ocaGroup = leg.oca_group
                    order.ocaType = 1
                if advanced_override:
                    order.advancedErrorOverride = ",".join(advanced_override)

                trade = self._ib.placeOrder(contract, order)
                trades.append((leg, trade))

            # Wait briefly for TWS to fire any immediate advanced reject errors.
            await asyncio.sleep(0.3)
            if captured_rejects and any(t.orderStatus.status not in _ACCEPTED for _, t in trades):
                raise TwsAdvancedRejectError(captured_rejects[0])
        finally:
            self._ib.errorEvent -= _on_error

        legs_out = [
            TwsOrderPackageLegSubmission(
                role=leg.role,
                order_id=trade.order.orderId,
                status=trade.orderStatus.status or "sent_to_tws",
            )
            for leg, trade in trades
        ]
        return TwsOrderPackageSubmission(
            package_id=preview.package_id,
            status=legs_out[0].status,
            order_ids=[leg.order_id for leg in legs_out],
            legs=legs_out,
        )

    def _ensure_order_mutation_allowed(self, *, mode: str, live_policy: object | None = None) -> None:
        """Shared guard for cancel and modify — fail closed before any broker call."""
        if self._kill_switch_active:
            raise TwsPlaceOrderGuardError("kill_switch_active")
        if not self.is_connected():
            raise TwsPlaceOrderGuardError("not_connected")
        if mode == "paper":
            if not self.is_paper_port():
                raise TwsPlaceOrderGuardError("not_paper_port")
            return
        if mode == "live":
            if live_policy is None:
                raise TwsPlaceOrderGuardError("live_session_not_armed")
            live_policy.assert_live_allowed(  # type: ignore[union-attr]
                account_id=self.connected_account_id(),
                host=self.connected_host(),
                port=self.connected_port(),
                is_connected=self.is_connected(),
                is_paper_port=self.is_paper_port(),
            )
            return
        raise TwsPlaceOrderGuardError("unsupported_execution_mode")

    def _open_trade_by_order_id(self, order_id: int):  # type: ignore[return]
        for trade in self._ib.openTrades():
            if trade.order.orderId == order_id:
                return trade
        return None

    def cancel_order(self, order_id: int, *, mode: str = "paper", live_policy: object | None = None) -> TwsOrderActionResult:
        self._ensure_order_mutation_allowed(mode=mode, live_policy=live_policy)
        trade = self._open_trade_by_order_id(order_id)
        if trade is None:
            raise TwsPlaceOrderGuardError("order_not_found")
        self._ib.cancelOrder(trade.order)
        status_text = trade.orderStatus.status or "cancel_requested"
        return TwsOrderActionResult(
            order_id=order_id,
            status=status_text,
            action="cancel",
            message="Cancel request sent to TWS.",
        )

    async def modify_order(
        self,
        order_id: int,
        req: TwsModifyOrderRequest,
        *,
        mode: str = "paper",
        live_policy: object | None = None,
        advanced_override: list[str] | None = None,
    ) -> TwsOrderActionResult:
        self._ensure_order_mutation_allowed(mode=mode, live_policy=live_policy)
        trade = self._open_trade_by_order_id(order_id)
        if trade is None:
            raise TwsPlaceOrderGuardError("order_not_found")
        if not can_modify_order_type(trade.order.orderType):
            raise TwsPlaceOrderGuardError("unsupported_order_type")
        if req.quantity <= 0:
            raise TwsPlaceOrderGuardError("invalid_quantity")
        if trade.order.orderType in ("LMT", "STP LMT"):
            if not (req.limit_price and req.limit_price > 0):
                raise TwsPlaceOrderGuardError("invalid_limit_price")
        if trade.order.orderType in ("STP", "STP LMT"):
            if not (req.stop_price and req.stop_price > 0):
                raise TwsPlaceOrderGuardError("invalid_stop_price")

        updated = copy.copy(trade.order)
        updated.totalQuantity = req.quantity
        if req.limit_price is not None:
            updated.lmtPrice = req.limit_price
        if req.stop_price is not None:
            updated.auxPrice = req.stop_price
        if advanced_override:
            updated.advancedErrorOverride = ",".join(advanced_override)

        captured_rejects: list[TwsAdvancedReject] = []

        def _on_error(req_id: int, code: int, msg: str, contract: object) -> None:
            if code in _ADVANCED_REJECT_CODES and msg:
                captured_rejects.append(_advanced_reject_from_raw(order_id, msg))

        _ACCEPTED: frozenset[str] = frozenset({"PreSubmitted", "Submitted", "Filled", "PartiallyFilled"})

        self._ib.errorEvent += _on_error
        try:
            result = self._ib.placeOrder(trade.contract, updated)
            await asyncio.sleep(0.3)
            if captured_rejects and result.orderStatus.status not in _ACCEPTED:
                raise TwsAdvancedRejectError(captured_rejects[0])
        finally:
            self._ib.errorEvent -= _on_error

        status_text = result.orderStatus.status or "modify_requested"
        return TwsOrderActionResult(
            order_id=order_id,
            status=status_text,
            action="modify",
            message="Modify request sent to TWS.",
        )

    # Timeframe → (IBKR barSizeSetting, durationStr)
    _TF_MAP: dict[str, tuple[str, str]] = {
        "1m":  ("1 min",   "1 D"),
        "5m":  ("5 mins",  "5 D"),
        "15m": ("15 mins", "10 D"),
        "30m": ("30 mins", "20 D"),
        "4h":  ("4 hours", "30 D"),
        "1D":  ("1 day",   "1 Y"),
        "1W":  ("1 week",  "3 Y"),
    }

    async def get_bars(self, conid: int, timeframe: str) -> BarsResponse:
        """Fetch read-only OHLCV bars for a conid at the requested timeframe.

        Returns an empty bars list when not connected or on any fetch error —
        the caller treats an empty list as "unavailable" without raising.
        Read-only: no order actions, no account data.
        """
        if not self._ib.isConnected():
            return BarsResponse(conid=conid, timeframe=timeframe)

        bar_size, duration = self._TF_MAP[timeframe]  # router validates; KeyError here is a bug
        contract = Contract(conId=conid, secType="STK", exchange="SMART", currency="USD")
        try:
            raw = await self._ib.reqHistoricalDataAsync(
                contract,
                endDateTime="",
                durationStr=duration,
                barSizeSetting=bar_size,
                whatToShow="TRADES",
                useRTH=True,
                formatDate=1,
                keepUpToDate=False,
                timeout=30,
            )
        except (RuntimeError, OSError, asyncio.TimeoutError) as exc:
            log.warning("Bars fetch failed conid=%s tf=%s: %s", conid, timeframe, exc)
            return BarsResponse(conid=conid, timeframe=timeframe)

        bars: list[BarSnapshot] = []
        for bar in raw:
            try:
                d = bar.date
                if isinstance(d, datetime):
                    t = int(d.timestamp())
                elif isinstance(d, date_):
                    t = int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())
                else:
                    continue
                bars.append(BarSnapshot(
                    time=t, open=bar.open, high=bar.high,
                    low=bar.low, close=bar.close, volume=bar.volume,
                ))
            except (TypeError, ValueError, AttributeError, OverflowError):
                continue

        return BarsResponse(conid=conid, timeframe=timeframe, bars=bars)
