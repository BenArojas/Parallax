from __future__ import annotations

import uuid

from models.tws_execution_assistant import (
    TwsOrderLegPreview,
    TwsOrderPackagePreview,
    TwsOrderPackageRequest,
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
