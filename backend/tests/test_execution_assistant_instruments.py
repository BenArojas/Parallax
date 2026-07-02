"""
Tests for instrument search and quote snapshot endpoints.

Critical promise: endpoints return empty results (not 500) when adapter is
disconnected or when the upstream TWS call fails.
"""

import asyncio
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from ib_async import Contract

from deps import get_broker_session, get_tws_adapter
from routers.execution_assistant import router as ea_router
from services.broker_session import BrokerSessionService
from services.tws_broker_adapter import TwsBrokerAdapter
from models.tws_execution_assistant import InstrumentResult, QuoteSnapshot


class _FakeIbkrState:
    authenticated = True


class _FakeIbkr:
    state = _FakeIbkrState()


class _FakeTwsAdapter:
    def __init__(
        self,
        *,
        search_results: list[InstrumentResult] | None = None,
        quote: QuoteSnapshot | None = None,
    ) -> None:
        self._search_results = search_results or []
        self._quote = quote or QuoteSnapshot()

    def is_connected(self) -> bool:
        return True

    async def check_api_server(self) -> bool:
        return True

    async def search_instruments(self, symbol: str) -> list[InstrumentResult]:
        return self._search_results

    async def get_quote(self, conid: int) -> QuoteSnapshot:
        return self._quote


def _client(
    *,
    search_results: list[InstrumentResult] | None = None,
    quote: QuoteSnapshot | None = None,
) -> TestClient:
    adapter = _FakeTwsAdapter(search_results=search_results, quote=quote)
    session = BrokerSessionService(_FakeIbkr(), adapter)

    app = FastAPI()
    app.include_router(ea_router)
    app.dependency_overrides[get_tws_adapter] = lambda: adapter
    app.dependency_overrides[get_broker_session] = lambda: session
    return TestClient(app)


def test_search_returns_results():
    results = [
        InstrumentResult(
            conid=265598,
            symbol="NVDA",
            sec_type="STK",
            exchange="SMART",
            primary_exchange="NASDAQ",
            currency="USD",
            local_symbol="NVDA",
            company_name="NVIDIA Corp",
        )
    ]
    r = _client(search_results=results).get(
        "/execution-assistant/instruments/search?symbol=NVDA"
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["conid"] == 265598
    assert body[0]["symbol"] == "NVDA"
    assert body[0]["primary_exchange"] == "NASDAQ"


def test_search_empty_when_no_results():
    r = _client().get("/execution-assistant/instruments/search?symbol=XXXXXXX")
    assert r.status_code == 200
    assert r.json() == []


def test_quote_returns_snapshot():
    q = QuoteSnapshot(last=131.50, bid=131.48, ask=131.52, close=130.00)
    r = _client(quote=q).get("/execution-assistant/instruments/265598/quote")
    assert r.status_code == 200
    body = r.json()
    assert body["last"] == 131.50
    assert body["bid"] == 131.48
    assert body["ask"] == 131.52
    assert body["close"] == 130.00
    assert body["open"] is None


def test_quote_returns_empty_snapshot_when_no_data():
    """Disconnected adapter returns all-None snapshot, not a 500."""
    r = _client().get("/execution-assistant/instruments/12345/quote")
    assert r.status_code == 200
    body = r.json()
    assert body["last"] is None
    assert body["bid"] is None


# ── Adapter-level regression: primaryExchange field name ─────────────────────

class _NoopEvent:
    """Minimal errorEvent stand-in for fake IB objects that don't emit errors."""
    def __iadd__(self, fn: object) -> "_NoopEvent":
        return self
    def __isub__(self, fn: object) -> "_NoopEvent":
        return self


class _CallableEvent:
    """Minimal errorEvent that records handlers and supports emit()."""
    def __init__(self) -> None:
        self._handlers: list = []

    def __iadd__(self, fn: object) -> "_CallableEvent":
        self._handlers.append(fn)
        return self

    def __isub__(self, fn: object) -> "_CallableEvent":
        if fn in self._handlers:
            self._handlers.remove(fn)
        return self

    def emit(self, *args: object) -> None:
        for h in self._handlers:
            h(*args)


def test_adapter_get_quote_passes_exchange_to_ib():
    """Regression: Contract(conId=...) alone triggers IBKR Warning 321.

    get_quote() must include secType/exchange/currency so IBKR can route
    the market data request. Also verifies reqMarketDataType(4) is called
    for the delayed-frozen fallback before the snapshot request.
    """
    from ib_async import Ticker

    captured: list[Contract] = []
    mdt_calls: list[int] = []

    class _FakeIB:
        errorEvent = _NoopEvent()

        def isConnected(self) -> bool:
            return True

        def reqMarketDataType(self, mdt: int) -> None:
            mdt_calls.append(mdt)

        async def reqTickersAsync(self, *contracts):
            captured.extend(contracts)
            ticker = Ticker(contract=contracts[0])
            ticker.bid = 131.48
            ticker.ask = 131.52
            ticker.last = 131.50
            return [ticker]

        def cancelMktData(self, _contract):
            pass

    adapter = TwsBrokerAdapter()
    adapter._ib = _FakeIB()  # type: ignore[assignment]
    adapter._state = "connected"

    result = asyncio.run(adapter.get_quote(265598))

    assert len(captured) == 1
    sent = captured[0]
    assert sent.exchange == "SMART", "IBKR needs exchange for market data (Warning 321)"
    assert sent.secType == "STK"
    assert sent.currency == "USD"
    assert result.bid == 131.48
    assert result.ask == 131.52
    assert result.last == 131.50
    assert mdt_calls == [4], "reqMarketDataType(4) must be called for delayed-frozen fallback"


def test_adapter_get_quote_error_10089_no_data_returns_structured_unavailable():
    """IBKR error 10089 with no ticker data returns structured unavailable, not silent all-null.

    reqMarketDataType(4) causes IBKR to fire 10089 as a warning and then return
    delayed data if available. When NO data comes back alongside the warning,
    the response must be specific unavailable, not an indistinguishable all-null.

    Critical promise: external failures stop safely and visibly (docs/testing.md #5).
    """
    from ib_async import Contract as IbContract, Ticker

    class _FakeIB:
        def __init__(self) -> None:
            self.errorEvent = _CallableEvent()

        def isConnected(self) -> bool:
            return True

        def reqMarketDataType(self, _mdt: int) -> None:
            pass

        async def reqTickersAsync(self, *contracts):
            # 10089 with an empty ticker — no delayed data available for this symbol.
            self.errorEvent.emit(1, 10089, "No market data permissions", contracts[0] if contracts else None)
            return [Ticker(contract=contracts[0] if contracts else IbContract())]

        def cancelMktData(self, _contract: object) -> None:
            pass

    adapter = TwsBrokerAdapter()
    adapter._ib = _FakeIB()  # type: ignore[assignment]
    adapter._state = "connected"

    result = asyncio.run(adapter.get_quote(265598))

    assert result.market_data_type == "unavailable"
    assert result.error_code == 10089
    assert result.unavailable_reason is not None
    assert "subscription" in result.unavailable_reason.lower()
    assert result.is_delayed is False
    assert result.bid is None
    assert result.last is None


def test_adapter_search_uses_primary_exchange_not_primary_exch():
    """Regression: ib_async Contract uses primaryExchange, not primaryExch.

    The router tests mock the whole adapter so they miss this field-name bug.
    This test wires a fake IB object into TwsBrokerAdapter directly.
    """
    contract = Contract(
        conId=265598,
        symbol="AAPL",
        secType="STK",
        exchange="SMART",
        currency="USD",
        localSymbol="AAPL",
    )
    contract.primaryExchange = "NASDAQ"

    detail = SimpleNamespace(contract=contract)

    class _FakeIB:
        def isConnected(self) -> bool:
            return True

        async def reqContractDetailsAsync(self, _contract):
            return [detail]

    adapter = TwsBrokerAdapter()
    adapter._ib = _FakeIB()  # type: ignore[assignment]
    adapter._state = "connected"

    results = asyncio.run(adapter.search_instruments("AAPL"))
    assert len(results) == 1
    assert results[0].primary_exchange == "NASDAQ"
    assert results[0].conid == 265598
