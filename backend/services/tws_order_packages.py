from __future__ import annotations

import re
import uuid

from models.tws_execution_assistant import (
    OrderSnapshot,
    PositionSnapshot,
    TwsOrderLegPreview,
    TwsOrderPackagePreview,
    TwsOrderPackageRequest,
    TwsPackageWarning,
    TwsScaleOutLotDraft,
)

_LOT_SUM_TOLERANCE = 1e-9


class TwsOrderPackageValidationError(Exception):
    """Raised when a package request fails validation before any broker call."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors))
        self.errors = errors


def _validate_lot(index: int, lot: TwsScaleOutLotDraft) -> list[str]:
    errors: list[str] = []
    if lot.quantity <= 0:
        errors.append(f"Lot {index} quantity must be positive.")
    if lot.target_price <= 0:
        errors.append(f"Lot {index} requires a positive target_price.")

    has_stop = lot.stop_price is not None and lot.stop_price > 0
    has_trail = lot.trail is not None
    if has_stop and has_trail:
        errors.append(f"Lot {index} must use exactly one stop style, not both stop_price and trail.")
    elif not has_stop and not has_trail:
        errors.append(f"Lot {index} requires exactly one stop style: stop_price or trail.")
    elif has_trail and lot.trail is not None:
        if lot.trail.mode == "percent" and not (0 < lot.trail.value < 100):
            errors.append(f"Lot {index} percent trail must be greater than 0 and less than 100.")
        if lot.trail.mode == "amount" and lot.trail.value <= 0:
            errors.append(f"Lot {index} fixed trail value must be positive.")

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


def preview_order_package(req: TwsOrderPackageRequest) -> TwsOrderPackagePreview:
    """Validate a package request and return the exact plain-data order graph."""
    if req.kind != "scale_out_ladder":
        raise TwsOrderPackageValidationError([f"Unsupported package kind: {req.kind}"])

    errors = _validate_scale_out_ladder(req)
    if errors:
        raise TwsOrderPackageValidationError(errors)

    package_id = str(uuid.uuid4())
    return TwsOrderPackagePreview(
        package_id=package_id,
        kind=req.kind,
        conid=req.conid,
        symbol=req.symbol,
        legs=_scale_out_ladder_legs(req, package_id),
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


def _parse_order_ref(order_ref: str) -> tuple[str, str] | None:
    """Return (package_id, role) for a well-formed ORBIT:TWS:<package_id>:<role> ref, else None."""
    match = _ORDER_REF_PATTERN.match(order_ref)
    return (match.group(1), match.group(2)) if match else None


def _lot_index(role: str) -> int | None:
    match = _LOT_ROLE_PATTERN.match(role)
    return int(match.group(1)) if match else None


def _is_known_role(role: str) -> bool:
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
    # can actually execute), so they count once — not once per leg.
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
            if order.oca_group:
                grouped_max[order.oca_group] = max(grouped_max.get(order.oca_group, 0.0), order.quantity)
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
