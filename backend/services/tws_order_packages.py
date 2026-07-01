from __future__ import annotations

import re
import uuid
from typing import Literal

from models.tws_execution_assistant import (
    OrderSnapshot,
    PositionSnapshot,
    TwsOrderLegPreview,
    TwsOrderPackagePreview,
    TwsOrderPackageRequest,
    TwsPackageWarning,
    TwsScaleOutLotDraft,
    TwsTrailSpec,
)

_LOT_SUM_TOLERANCE = 1e-9


class TwsOrderPackageValidationError(Exception):
    """Raised when a package request fails validation before any broker call."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def _validate_trail_value(prefix: str, trail: TwsTrailSpec) -> list[str]:
    """Shared by every trail context: scale-out lots, brackets, and standalone trailing stops."""
    errors: list[str] = []
    if trail.mode == "percent" and not (0 < trail.value < 100):
        errors.append(f"{prefix} percent trail must be greater than 0 and less than 100.")
    if trail.mode == "amount" and trail.value <= 0:
        errors.append(f"{prefix} fixed trail value must be positive.")
    return errors


def _validate_stop_style(prefix: str, stop_price: float | None, trail: TwsTrailSpec | None) -> list[str]:
    """Shared by scale-out lots and brackets: exactly one of a fixed stop or a trail."""
    errors: list[str] = []
    has_stop = stop_price is not None and stop_price > 0
    has_trail = trail is not None
    if has_stop and has_trail:
        errors.append(f"{prefix} must use exactly one stop style, not both stop_price and trail.")
    elif not has_stop and not has_trail:
        errors.append(f"{prefix} requires exactly one stop style: stop_price or trail.")
    elif has_trail and trail is not None:
        errors.extend(_validate_trail_value(prefix, trail))
    return errors


def _validate_lot(index: int, lot: TwsScaleOutLotDraft) -> list[str]:
    errors: list[str] = []
    if lot.quantity <= 0:
        errors.append(f"Lot {index} quantity must be positive.")
    if lot.target_price <= 0:
        errors.append(f"Lot {index} requires a positive target_price.")
    errors.extend(_validate_stop_style(f"Lot {index}", lot.stop_price, lot.trail))
    return errors


def _validate_scale_out_ladder(req: TwsOrderPackageRequest) -> list[str]:
    errors: list[str] = []

    if req.side != "BUY":
        errors.append("Scale-out ladders are long-only; side must be BUY.")
    if req.quantity <= 0:
        errors.append("Entry quantity must be positive.")
    if req.order_type not in ("MKT", "LMT"):
        errors.append("Entry order_type must be MKT or LMT.")
    if req.order_type == "LMT" and not (req.limit_price is not None and req.limit_price > 0):
        errors.append("LMT entry requires a positive limit_price.")

    if not req.lots:
        errors.append("At least one lot is required.")

    lot_total = 0.0
    for i, lot in enumerate(req.lots):
        errors.extend(_validate_lot(i, lot))
        if lot.quantity > 0:
            lot_total += lot.quantity

    if req.lots and abs(lot_total - req.quantity) > _LOT_SUM_TOLERANCE:
        errors.append(f"Lot quantities must sum exactly to entry quantity ({req.quantity}); got {lot_total}.")

    return errors


def _scale_out_ladder_legs(req: TwsOrderPackageRequest, package_id: str) -> list[TwsOrderLegPreview]:
    """Build one isolated parent-entry per lot.

    TWS auto-links every order sharing a parentId into one OCA-managed cohort,
    independent of any custom ocaGroup string (confirmed against a live paper
    account: a single shared "entry" parent collapsed all lots' exits into one
    TWS-assigned OCA group and normalized every exit's quantity to the parent's
    full size). Giving each lot its own parent entry, sized to that lot only,
    keeps TWS's auto-linking scoped per lot instead of across the whole package.
    """
    legs: list[TwsOrderLegPreview] = []
    for i, lot in enumerate(req.lots):
        entry_role = f"lot{i}_entry"
        oca_group = f"ORBIT-{package_id}-LOT{i}"
        legs.append(TwsOrderLegPreview(
            role=entry_role,
            side=req.side,
            quantity=lot.quantity,
            order_type=req.order_type,
            limit_price=req.limit_price,
            transmit=False,
        ))
        legs.append(TwsOrderLegPreview(
            role=f"lot{i}_target",
            side="SELL",
            quantity=lot.quantity,
            order_type="LMT",
            limit_price=lot.target_price,
            parent_ref=entry_role,
            oca_group=oca_group,
            transmit=False,
        ))
        if lot.trail is not None:
            legs.append(TwsOrderLegPreview(
                role=f"lot{i}_trail",
                side="SELL",
                quantity=lot.quantity,
                order_type="TRAIL",
                trail=lot.trail,
                parent_ref=entry_role,
                oca_group=oca_group,
                transmit=False,
            ))
        else:
            legs.append(TwsOrderLegPreview(
                role=f"lot{i}_stop",
                side="SELL",
                quantity=lot.quantity,
                order_type="STP",
                stop_price=lot.stop_price,
                parent_ref=entry_role,
                oca_group=oca_group,
                transmit=False,
            ))
        legs.append(TwsOrderLegPreview(
            role=f"lot{i}_moc_fallback",
            side="SELL",
            quantity=lot.quantity,
            order_type="MOC",
            parent_ref=entry_role,
            oca_group=oca_group,
            transmit=False,
        ))

    # TWS only routes the whole package once the final child transmits.
    legs[-1] = legs[-1].model_copy(update={"transmit": True})
    return legs


def _validate_bracket(req: TwsOrderPackageRequest) -> list[str]:
    errors: list[str] = []
    if req.quantity <= 0:
        errors.append("Quantity must be positive.")
    if req.side not in ("BUY", "SELL"):
        errors.append("Side must be BUY or SELL.")
    if req.order_type not in ("MKT", "LMT"):
        errors.append("Entry order_type must be MKT or LMT.")
    if req.order_type == "LMT" and not (req.limit_price is not None and req.limit_price > 0):
        errors.append("LMT entry requires a positive limit_price.")
    if not (req.target_price is not None and req.target_price > 0):
        errors.append("A positive target_price is required.")
    errors.extend(_validate_stop_style("Bracket", req.stop_price, req.trail))
    return errors


def _bracket_legs(req: TwsOrderPackageRequest) -> list[TwsOrderLegPreview]:
    """Standard IBKR bracket: one parent entry, a profit-taker child, and a
    stop-or-trailing child, all three sharing the parent's orderId as parentId
    (mirrors ib_async's IB.bracketOrder() helper). Unlike scale-out, a bracket
    is exactly one lot, so one shared parent is the correct pattern here — not
    the per-lot parent isolation scale-out needed for its multi-lot case.
    """
    exit_side: Literal["BUY", "SELL"] = "SELL" if req.side == "BUY" else "BUY"
    legs = [
        TwsOrderLegPreview(
            role="parent",
            side=req.side,
            quantity=req.quantity,
            order_type=req.order_type,
            limit_price=req.limit_price,
            transmit=False,
        ),
        TwsOrderLegPreview(
            role="target",
            side=exit_side,
            quantity=req.quantity,
            order_type="LMT",
            limit_price=req.target_price,
            parent_ref="parent",
            transmit=False,
        ),
    ]
    if req.trail is not None:
        legs.append(TwsOrderLegPreview(
            role="trail",
            side=exit_side,
            quantity=req.quantity,
            order_type="TRAIL",
            trail=req.trail,
            parent_ref="parent",
            transmit=True,
        ))
    else:
        legs.append(TwsOrderLegPreview(
            role="stop",
            side=exit_side,
            quantity=req.quantity,
            order_type="STP",
            stop_price=req.stop_price,
            parent_ref="parent",
            transmit=True,
        ))
    return legs


def _validate_trailing_stop(req: TwsOrderPackageRequest) -> list[str]:
    errors: list[str] = []
    if req.quantity <= 0:
        errors.append("Quantity must be positive.")
    if req.side not in ("BUY", "SELL"):
        errors.append("Side must be BUY or SELL.")
    if req.order_type not in ("TRAIL", "TRAILLMT"):
        errors.append("Trailing stop order_type must be TRAIL or TRAILLMT.")
    if req.trail is None:
        errors.append("A trail spec is required.")
    else:
        errors.extend(_validate_trail_value("Trailing stop", req.trail))
    if req.order_type == "TRAILLMT" and not (req.limit_offset is not None and req.limit_offset > 0):
        errors.append("TRAILLMT requires a positive limit_offset.")
    return errors


def _trailing_stop_leg(req: TwsOrderPackageRequest) -> list[TwsOrderLegPreview]:
    return [TwsOrderLegPreview(
        role="trailing_stop",
        side=req.side,
        quantity=req.quantity,
        order_type=req.order_type,
        trail=req.trail,
        limit_offset=req.limit_offset if req.order_type == "TRAILLMT" else None,
        transmit=True,
    )]


# Working order types TWS can hold open until good_till_date — MKT fills immediately
# and can't meaningfully be "good till" anything, so it's excluded on purpose.
_GTD_WORKING_ORDER_TYPES = frozenset({"LMT", "STP", "STP LMT", "TRAIL", "TRAILLMT"})


def _validate_gtd(req: TwsOrderPackageRequest) -> list[str]:
    """Rejects any field not applicable to the selected order_type, not just missing
    required ones — the same discipline _validate_moc already applies to limit_price.
    Without this, a GTD TRAIL request carrying a stray stop_price or limit_price would
    pass preview and reach the adapter, which sets auxPrice/lmtPrice unconditionally
    whenever they're non-null — producing a broker order with both auxPrice and
    trailingPercent set, violating the required mutual exclusivity between them."""
    errors: list[str] = []
    if req.quantity <= 0:
        errors.append("Quantity must be positive.")
    if req.side not in ("BUY", "SELL"):
        errors.append("Side must be BUY or SELL.")
    if not req.good_till_date:
        errors.append("good_till_date is required for a GTD order.")
    if req.order_type not in _GTD_WORKING_ORDER_TYPES:
        errors.append(f"GTD order_type must be one of {sorted(_GTD_WORKING_ORDER_TYPES)}.")
        return errors  # remaining checks assume a recognized order_type

    wants_limit = req.order_type in ("LMT", "STP LMT")
    wants_stop = req.order_type in ("STP", "STP LMT")
    wants_trail = req.order_type in ("TRAIL", "TRAILLMT")

    if wants_limit and not (req.limit_price is not None and req.limit_price > 0):
        errors.append(f"{req.order_type} GTD requires a positive limit_price.")
    if not wants_limit and req.limit_price is not None:
        errors.append(f"{req.order_type} GTD must not have a limit_price.")

    if wants_stop and not (req.stop_price is not None and req.stop_price > 0):
        errors.append(f"{req.order_type} GTD requires a positive stop_price.")
    if not wants_stop and req.stop_price is not None:
        errors.append(f"{req.order_type} GTD must not have a stop_price.")

    if wants_trail:
        if req.trail is None:
            errors.append("A trail spec is required for a trailing GTD order.")
        else:
            errors.extend(_validate_trail_value("GTD trailing", req.trail))
        if req.order_type == "TRAILLMT" and not (req.limit_offset is not None and req.limit_offset > 0):
            errors.append("TRAILLMT GTD requires a positive limit_offset.")
    elif req.trail is not None:
        errors.append(f"{req.order_type} GTD must not have a trail.")

    return errors


def _gtd_leg(req: TwsOrderPackageRequest) -> list[TwsOrderLegPreview]:
    # Only forward fields the validated order_type actually uses — belt-and-suspenders
    # against the adapter ever seeing a conflicting field pair (see _validate_gtd).
    wants_limit = req.order_type in ("LMT", "STP LMT")
    wants_stop = req.order_type in ("STP", "STP LMT")
    wants_trail = req.order_type in ("TRAIL", "TRAILLMT")
    return [TwsOrderLegPreview(
        role="gtd",
        side=req.side,
        quantity=req.quantity,
        order_type=req.order_type,
        limit_price=req.limit_price if wants_limit else None,
        stop_price=req.stop_price if wants_stop else None,
        trail=req.trail if wants_trail else None,
        limit_offset=req.limit_offset if req.order_type == "TRAILLMT" else None,
        tif="GTD",
        good_till_date=req.good_till_date,
        transmit=True,
    )]


def _validate_moc(req: TwsOrderPackageRequest) -> list[str]:
    errors: list[str] = []
    if req.quantity <= 0:
        errors.append("Quantity must be positive.")
    if req.side not in ("BUY", "SELL"):
        errors.append("Side must be BUY or SELL.")
    if req.limit_price is not None:
        errors.append("MOC orders must not have a limit_price.")
    return errors


def _moc_leg(req: TwsOrderPackageRequest) -> list[TwsOrderLegPreview]:
    return [TwsOrderLegPreview(role="moc", side=req.side, quantity=req.quantity, order_type="MOC", transmit=True)]


def _validate_loc(req: TwsOrderPackageRequest) -> list[str]:
    errors: list[str] = []
    if req.quantity <= 0:
        errors.append("Quantity must be positive.")
    if req.side not in ("BUY", "SELL"):
        errors.append("Side must be BUY or SELL.")
    if not (req.limit_price is not None and req.limit_price > 0):
        errors.append("LOC requires a positive limit_price.")
    return errors


def _loc_leg(req: TwsOrderPackageRequest) -> list[TwsOrderLegPreview]:
    return [TwsOrderLegPreview(
        role="loc", side=req.side, quantity=req.quantity, order_type="LOC", limit_price=req.limit_price, transmit=True,
    )]


def _validate_price_condition(req: TwsOrderPackageRequest) -> list[str]:
    """A price-condition order is a plain MKT/LMT order with one extra trigger
    attached — not a scale-out lot, bracket, trailing stop, or GTD order, so
    none of those kinds' fields should ever be set alongside it."""
    errors: list[str] = []
    if req.conid <= 0:
        errors.append("A positive conid is required.")
    if not req.symbol:
        errors.append("A symbol is required.")
    if req.quantity <= 0:
        errors.append("Quantity must be positive.")
    if req.side not in ("BUY", "SELL"):
        errors.append("Side must be BUY or SELL.")
    if not (req.condition_price is not None and req.condition_price > 0):
        errors.append("A positive condition_price is required.")
    if req.condition_is_above is None:
        errors.append("condition_is_above must be explicitly true or false.")
    if req.order_type not in ("MKT", "LMT"):
        errors.append("Price-condition order_type must be MKT or LMT.")
    elif req.order_type == "LMT" and not (req.limit_price is not None and req.limit_price > 0):
        errors.append("LMT requires a positive limit_price.")
    elif req.order_type == "MKT" and req.limit_price is not None:
        errors.append("MKT price-condition orders must not have a limit_price.")

    if req.lots:
        errors.append("Price-condition orders must not have lots.")
    if req.trail is not None:
        errors.append("Price-condition orders must not have a trail.")
    if req.stop_price is not None:
        errors.append("Price-condition orders must not have a stop_price.")
    if req.target_price is not None:
        errors.append("Price-condition orders must not have a target_price.")
    if req.good_till_date is not None:
        errors.append("Price-condition orders must not have a good_till_date.")
    if req.limit_offset is not None:
        errors.append("Price-condition orders must not have a limit_offset.")
    return errors


def _price_condition_leg(req: TwsOrderPackageRequest) -> list[TwsOrderLegPreview]:
    return [TwsOrderLegPreview(
        role="price_condition",
        side=req.side,
        quantity=req.quantity,
        order_type=req.order_type,
        limit_price=req.limit_price if req.order_type == "LMT" else None,
        tif="DAY",
        condition_price=req.condition_price,
        condition_is_above=req.condition_is_above,
        transmit=True,
    )]


_VALIDATORS = {
    "scale_out_ladder": _validate_scale_out_ladder,
    "bracket": _validate_bracket,
    "trailing_stop": _validate_trailing_stop,
    "gtd": _validate_gtd,
    "moc": _validate_moc,
    "loc": _validate_loc,
    "price_condition": _validate_price_condition,
}


def preview_order_package(req: TwsOrderPackageRequest) -> TwsOrderPackagePreview:
    """Validate a package request and return the exact plain-data order graph."""
    validator = _VALIDATORS.get(req.kind)
    if validator is None:
        raise TwsOrderPackageValidationError([f"Unsupported package kind: {req.kind}"])

    errors = validator(req)
    if errors:
        raise TwsOrderPackageValidationError(errors)

    package_id = str(uuid.uuid4())
    if req.kind == "scale_out_ladder":
        legs = _scale_out_ladder_legs(req, package_id)
    elif req.kind == "bracket":
        legs = _bracket_legs(req)
    elif req.kind == "trailing_stop":
        legs = _trailing_stop_leg(req)
    elif req.kind == "gtd":
        legs = _gtd_leg(req)
    elif req.kind == "moc":
        legs = _moc_leg(req)
    elif req.kind == "loc":
        legs = _loc_leg(req)
    else:
        legs = _price_condition_leg(req)

    return TwsOrderPackagePreview(
        package_id=package_id,
        kind=req.kind,
        conid=req.conid,
        symbol=req.symbol,
        legs=legs,
    )


# ── Reconciliation warnings (Task 3) ─────────────────────────────────────────
#
# Read-only checks over the current TWS reconciliation snapshot (open_orders,
# positions) looking for package-shape problems Orbit itself would create by
# mistake — not a general order-book auditor. No persistence: recomputed fresh
# from whatever TWS reports as open right now.

_ORDER_REF_PATTERN = re.compile(r"^ORBIT:TWS:([^:]+):([^:]+)$")
_LOT_ROLE_PATTERN = re.compile(r"^lot(\d+)_(.+)$")
_KNOWN_LOT_ROLE_SUFFIXES = frozenset({"entry", "target", "stop", "trail", "moc_fallback"})
# Bracket legs have no lot concept (one parent, one target, one stop-or-trail child) —
# a flat role name, not the lot{N}_<suffix> shape scale-out uses. Trailing stop, GTD,
# MOC, LOC, and price_condition are one-leg packages (no parent/child at all), each
# with its own flat role.
_KNOWN_FLAT_ROLES = frozenset(
    {"parent", "target", "stop", "trail", "trailing_stop", "gtd", "moc", "loc", "price_condition"}
)


def _parse_order_ref(order_ref: str) -> tuple[str, str] | None:
    """Return (package_id, role) for a well-formed ORBIT:TWS:<package_id>:<role> ref, else None."""
    match = _ORDER_REF_PATTERN.match(order_ref)
    return (match.group(1), match.group(2)) if match else None


def _lot_index(role: str) -> int | None:
    match = _LOT_ROLE_PATTERN.match(role)
    return int(match.group(1)) if match else None


def _is_known_role(role: str) -> bool:
    if role in _KNOWN_FLAT_ROLES:
        return True
    match = _LOT_ROLE_PATTERN.match(role)
    return match is not None and match.group(2) in _KNOWN_LOT_ROLE_SUFFIXES


def _cross_lot_sharing_warnings(
    kind: str,
    package_id: str,
    order_ids: list[int],
    by_order_id: dict[int, OrderSnapshot],
    roles: dict[int, str],
    field: str,
) -> list[TwsPackageWarning]:
    """Shared logic for the parent_id and oca_group cross-lot checks — same shape, different field."""
    lots_by_value: dict[object, set[int]] = {}
    for order_id in order_ids:
        lot = _lot_index(roles[order_id])
        value = getattr(by_order_id[order_id], field)
        if lot is None or value is None:
            continue
        lots_by_value.setdefault(value, set()).add(lot)

    warnings: list[TwsPackageWarning] = []
    for value, lots in lots_by_value.items():
        if len(lots) <= 1:
            continue
        matching_ids = [oid for oid in order_ids if getattr(by_order_id[oid], field) == value]
        warnings.append(TwsPackageWarning(
            kind=kind,  # type: ignore[arg-type]
            message=(
                f"Package {package_id}: lots {sorted(lots)} share {field} {value!r} — "
                "TWS may treat them as one linked group instead of isolating each lot."
            ),
            package_id=package_id,
            order_ids=matching_ids,
        ))
    return warnings


def derive_package_warnings(
    open_orders: list[OrderSnapshot],
    positions: list[PositionSnapshot],
) -> list[TwsPackageWarning]:
    """Read-only scan for package-shape problems in the current reconciliation snapshot.

    A missing parent entry is never flagged on its own — a filled parent normally
    disappears from open_orders, which is expected, not a warning.
    """
    warnings: list[TwsPackageWarning] = []
    by_order_id = {o.order_id: o for o in open_orders}

    roles: dict[int, str] = {}
    package_ids: dict[int, str] = {}
    for order in open_orders:
        ref = order.order_ref
        if not ref or not ref.startswith("ORBIT:"):
            continue
        parsed = _parse_order_ref(ref)
        if parsed is None:
            warnings.append(TwsPackageWarning(
                kind="malformed_order_ref",
                message=f"Order {order.order_id} has a malformed Orbit order_ref: {ref!r}.",
                conid=order.conid,
                symbol=order.symbol,
                order_ids=[order.order_id],
            ))
            continue
        package_id, role = parsed
        roles[order.order_id] = role
        package_ids[order.order_id] = package_id
        if not _is_known_role(role):
            warnings.append(TwsPackageWarning(
                kind="unknown_role",
                message=f"Order {order.order_id} has an unrecognized package role {role!r}.",
                package_id=package_id,
                conid=order.conid,
                symbol=order.symbol,
                order_ids=[order.order_id],
            ))

    orders_by_package: dict[str, list[int]] = {}
    for order_id, package_id in package_ids.items():
        orders_by_package.setdefault(package_id, []).append(order_id)

    for package_id, order_ids in orders_by_package.items():
        warnings.extend(_cross_lot_sharing_warnings(
            "cross_lot_parent_id", package_id, order_ids, by_order_id, roles, "parent_id",
        ))
        warnings.extend(_cross_lot_sharing_warnings(
            "cross_lot_oca_group", package_id, order_ids, by_order_id, roles, "oca_group",
        ))

    # Active sell exposure vs. the current long position, respecting OCA grouping:
    # orders sharing one oca_group are alternatives for the same shares (only one
    # can actually execute), so they count once — not once per leg. Orders with no
    # oca_group but a shared parent_id (a bracket's target + stop/trail child, which
    # use TWS's native parent/child bracket linking instead of an OCA group) are the
    # same kind of mutually-exclusive alternative, so they group the same way.
    position_by_conid = {p.conid: p.position for p in positions}
    sell_orders_by_conid: dict[int, list[OrderSnapshot]] = {}
    for order in open_orders:
        if order.side == "SELL":
            sell_orders_by_conid.setdefault(order.conid, []).append(order)

    for conid, orders in sell_orders_by_conid.items():
        position = position_by_conid.get(conid, 0.0)
        if position <= 0:
            continue  # not a long position — over-sell risk is a different, already-accepted category
        grouped_max: dict[str, float] = {}
        ungrouped_total = 0.0
        for order in orders:
            key = order.oca_group or (f"parent:{order.parent_id}" if order.parent_id is not None else None)
            if key is not None:
                grouped_max[key] = max(grouped_max.get(key, 0.0), order.quantity)
            else:
                ungrouped_total += order.quantity
        exposure = sum(grouped_max.values()) + ungrouped_total
        if exposure > position:
            warnings.append(TwsPackageWarning(
                kind="sell_exposure_exceeds_position",
                message=(
                    f"{orders[0].symbol}: active sell exposure ({exposure:g} shares) exceeds "
                    f"the current long position ({position:g})."
                ),
                conid=conid,
                symbol=orders[0].symbol,
                order_ids=[o.order_id for o in orders],
            ))

    return warnings
