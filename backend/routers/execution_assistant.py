import logging

from fastapi import APIRouter, Depends, HTTPException, status

log = logging.getLogger(__name__)

from deps import get_broker_session, get_execution_plan_service, get_tws_adapter, get_tws_live_policy
from models.execution_plan import ExecutionPlan, ExecutionPlanDraftRequest
from models.tws_execution_assistant import (
    BarsResponse,
    InstrumentResult,
    PaperOrderPreview,
    PaperOrderSubmission,
    QuoteSnapshot,
    ReconciliationSnapshot,
    TwsAdvancedReject,
    TwsConnectRequest,
    TwsLiveAllowlistRequest,
    TwsLiveArmRequest,
    TwsLivePolicyStatus,
    TwsModifyOrderRequest,
    TwsOrderActionResult,
    TwsOrderPackagePreview,
    TwsOrderPackageRequest,
    TwsOrderPackageSubmission,
    TwsOverrideRequest,
    TwsStatusResponse,
)
from services.broker_session import BrokerSessionService
from services.execution_plan import ExecutionPlanService
from services.tws_broker_adapter import TwsAdvancedRejectError, TwsBrokerAdapter, TwsPlaceOrderGuardError
from services.tws_live_policy import TwsLivePolicyService
from services.tws_order_packages import TwsOrderPackageValidationError, preview_order_package

router = APIRouter(prefix="/execution-assistant", tags=["execution-assistant"])

_GUARD_STATUS: dict[str, int] = {
    "kill_switch_active": status.HTTP_409_CONFLICT,
    "not_connected": status.HTTP_409_CONFLICT,
    "not_paper_port": status.HTTP_403_FORBIDDEN,
    "plan_not_valid": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "order_not_found": status.HTTP_404_NOT_FOUND,
    "unsupported_order_type": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "invalid_quantity": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "invalid_limit_price": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "invalid_stop_price": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "paper_port_cannot_arm_live": status.HTTP_403_FORBIDDEN,
    "paper_port_cannot_live_trade": status.HTTP_403_FORBIDDEN,
    "live_session_mismatch": status.HTTP_409_CONFLICT,
    "live_session_not_allowlisted": status.HTTP_403_FORBIDDEN,
    "live_session_not_armed": status.HTTP_403_FORBIDDEN,
}


def _guard_http_error(exc: TwsPlaceOrderGuardError) -> HTTPException:
    return HTTPException(
        status_code=_GUARD_STATUS.get(exc.error_code, status.HTTP_409_CONFLICT),
        detail={"error": exc.error_code},
    )


@router.get("/status", response_model=TwsStatusResponse)
async def get_status(
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    session: BrokerSessionService = Depends(get_broker_session),
) -> TwsStatusResponse:
    available = await adapter.check_api_server()
    return adapter.get_status(session.current_mode(), available)


@router.post("/connect", response_model=TwsStatusResponse)
async def connect(
    request: TwsConnectRequest,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    session: BrokerSessionService = Depends(get_broker_session),
) -> TwsStatusResponse:
    await adapter.connect(request.host, request.port, request.client_id)
    available = await adapter.check_api_server()
    return adapter.get_status(session.current_mode(), available)


@router.post("/disconnect", response_model=TwsStatusResponse)
async def disconnect(
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    session: BrokerSessionService = Depends(get_broker_session),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsStatusResponse:
    policy.disarm()
    await adapter.disconnect()
    available = await adapter.check_api_server()
    return adapter.get_status(session.current_mode(), available)


@router.get("/reconciliation", response_model=ReconciliationSnapshot)
async def get_reconciliation(
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
) -> ReconciliationSnapshot:
    return adapter.get_reconciliation()


# ── Live policy ──────────────────────────────────────────────────────────────

def _live_status(adapter: TwsBrokerAdapter, policy: TwsLivePolicyService) -> TwsLivePolicyStatus:
    return policy.status(
        account_id=adapter.connected_account_id(),
        host=adapter.connected_host(),
        port=adapter.connected_port(),
        is_connected=adapter.is_connected(),
        is_paper_port=adapter.is_paper_port(),
    )


@router.get("/live/status", response_model=TwsLivePolicyStatus)
async def get_live_status(
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsLivePolicyStatus:
    return _live_status(adapter, policy)


@router.post("/live/allow", response_model=TwsLivePolicyStatus)
async def allow_live_session(
    req: TwsLiveAllowlistRequest,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsLivePolicyStatus:
    policy.allow(req)
    return _live_status(adapter, policy)


@router.post("/live/arm", response_model=TwsLivePolicyStatus)
async def arm_live_session(
    req: TwsLiveArmRequest,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsLivePolicyStatus:
    try:
        policy.arm(
            req,
            account_id=adapter.connected_account_id(),
            host=adapter.connected_host(),
            port=adapter.connected_port(),
            is_connected=adapter.is_connected(),
            is_paper_port=adapter.is_paper_port(),
        )
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    return _live_status(adapter, policy)


@router.post("/live/disarm", response_model=TwsLivePolicyStatus)
async def disarm_live_session(
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsLivePolicyStatus:
    policy.disarm()
    return _live_status(adapter, policy)


# ── Instrument search + quote ────────────────────────────────────────────────

@router.get("/instruments/search", response_model=list[InstrumentResult])
async def search_instruments(
    symbol: str,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
) -> list[InstrumentResult]:
    return await adapter.search_instruments(symbol.upper().strip())


@router.get("/instruments/{conid}/quote", response_model=QuoteSnapshot)
async def get_quote(
    conid: int,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
) -> QuoteSnapshot:
    return await adapter.get_quote(conid)


_ALLOWED_TIMEFRAMES: frozenset[str] = frozenset({"1m", "5m", "15m", "30m", "4h", "1D", "1W"})


@router.get("/instruments/{conid}/bars", response_model=BarsResponse)
async def get_bars(
    conid: int,
    timeframe: str = "5m",
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
) -> BarsResponse:
    if timeframe not in _ALLOWED_TIMEFRAMES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "unsupported_timeframe",
                "timeframe": timeframe,
                "allowed": sorted(_ALLOWED_TIMEFRAMES),
            },
        )
    return await adapter.get_bars(conid, timeframe)


# ── Execution plan draft + validation ────────────────────────────────────────

@router.post("/plans/draft", response_model=ExecutionPlan, status_code=201)
async def create_plan_draft(
    request: ExecutionPlanDraftRequest,
    svc: ExecutionPlanService = Depends(get_execution_plan_service),
) -> ExecutionPlan:
    return svc.create_draft(request)


@router.get("/plans/{plan_id}", response_model=ExecutionPlan)
async def get_plan(
    plan_id: str,
    svc: ExecutionPlanService = Depends(get_execution_plan_service),
) -> ExecutionPlan:
    plan = svc.get(plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "plan_not_found", "plan_id": plan_id},
        )
    return plan


@router.post("/plans/{plan_id}/validate", response_model=ExecutionPlan)
async def validate_plan(
    plan_id: str,
    svc: ExecutionPlanService = Depends(get_execution_plan_service),
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
) -> ExecutionPlan:
    plan = svc.get(plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "plan_not_found", "plan_id": plan_id},
        )
    return await svc.validate(plan, adapter)


@router.post("/plans/{plan_id}/preview-paper", response_model=PaperOrderPreview)
async def preview_paper_order(
    plan_id: str,
    svc: ExecutionPlanService = Depends(get_execution_plan_service),
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
) -> PaperOrderPreview:
    if not adapter.is_connected():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "not_connected"},
        )
    if not adapter.is_paper_port():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "not_paper_port",
                "message": "Connected port is not a known paper port (4002 or 7497). Order actions are read-only on live and unknown ports.",
            },
        )
    plan = svc.get(plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "plan_not_found", "plan_id": plan_id},
        )
    if plan.status != "valid":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "plan_not_valid", "status": plan.status},
        )
    return svc.preview_paper(plan)


@router.post("/plans/{plan_id}/preview-live", response_model=PaperOrderPreview)
async def preview_live_order(
    plan_id: str,
    svc: ExecutionPlanService = Depends(get_execution_plan_service),
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> PaperOrderPreview:
    try:
        policy.assert_live_allowed(
            account_id=adapter.connected_account_id(),
            host=adapter.connected_host(),
            port=adapter.connected_port(),
            is_connected=adapter.is_connected(),
            is_paper_port=adapter.is_paper_port(),
        )
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    plan = svc.get(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail={"error": "plan_not_found", "plan_id": plan_id})
    if plan.status != "valid":
        raise HTTPException(status_code=422, detail={"error": "plan_not_valid", "status": plan.status})
    preview = svc.preview_paper(plan)
    return preview.model_copy(update={"paper_only": False})


@router.post("/plans/{plan_id}/place-live", response_model=PaperOrderSubmission)
async def place_live_order(
    plan_id: str,
    svc: ExecutionPlanService = Depends(get_execution_plan_service),
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> PaperOrderSubmission:
    try:
        policy.assert_live_allowed(
            account_id=adapter.connected_account_id(),
            host=adapter.connected_host(),
            port=adapter.connected_port(),
            is_connected=adapter.is_connected(),
            is_paper_port=adapter.is_paper_port(),
        )
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    plan = svc.get(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail={"error": "plan_not_found", "plan_id": plan_id})
    if plan.status != "valid":
        raise HTTPException(status_code=422, detail={"error": "plan_not_valid", "status": plan.status})
    try:
        return await adapter.place_order(plan, mode="live", live_policy=policy)
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    except TwsAdvancedRejectError as exc:
        raise HTTPException(status_code=409, detail={"error": "advanced_reject", "reject": exc.reject.model_dump()})
    except (RuntimeError, OSError, ConnectionError, TimeoutError) as exc:
        log.error("Live order placement failed for plan %s: %s", plan_id, exc)
        raise HTTPException(
            status_code=409,
            detail={
                "error": "unknown_outcome",
                "message": "Live order placement failed unexpectedly. Check TWS Open Orders before retrying.",
            },
        )


@router.post("/plans/{plan_id}/place-paper", response_model=PaperOrderSubmission)
async def place_paper_order(
    plan_id: str,
    svc: ExecutionPlanService = Depends(get_execution_plan_service),
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
) -> PaperOrderSubmission:
    if adapter.is_kill_switch_active():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "kill_switch_active"},
        )
    if not adapter.is_connected():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "not_connected"},
        )
    if not adapter.is_paper_port():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "error": "not_paper_port",
                "message": "Connected port is not a known paper port (4002 or 7497). Order placement is blocked on live and unknown ports.",
            },
        )
    plan = svc.get(plan_id)
    if plan is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "plan_not_found", "plan_id": plan_id},
        )
    if plan.status != "valid":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "plan_not_valid", "status": plan.status},
        )
    try:
        return await adapter.place_paper_order(plan)
    except TwsPlaceOrderGuardError as exc:
        # Guard fired after the router's own pre-call check (state changed between
        # check and call). Order was never sent — outcome is deterministic.
        raise _guard_http_error(exc)
    except TwsAdvancedRejectError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "advanced_reject", "reject": exc.reject.model_dump()},
        )
    except (RuntimeError, OSError, ConnectionError, TimeoutError) as exc:
        # Failure at or after the placeOrder() call — outcome is ambiguous.
        # The order may have reached TWS; warn the user before retrying.
        log.error("Paper order placement failed for plan %s: %s", plan_id, exc)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "unknown_outcome",
                "message": (
                    "Order placement failed unexpectedly. Check TWS Open Orders "
                    "before retrying — the order may have reached TWS."
                ),
            },
        )


# ── Cancel / Modify open orders ──────────────────────────────────────────────

def _order_mode(adapter: TwsBrokerAdapter) -> str:
    return "paper" if adapter.is_paper_port() else "live"


def _assert_live_precheck(adapter: TwsBrokerAdapter, policy: TwsLivePolicyService) -> None:
    try:
        policy.assert_live_allowed(
            account_id=adapter.connected_account_id(),
            host=adapter.connected_host(),
            port=adapter.connected_port(),
            is_connected=adapter.is_connected(),
            is_paper_port=adapter.is_paper_port(),
        )
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)


@router.delete("/orders/{order_id}", response_model=TwsOrderActionResult)
async def cancel_order(
    order_id: int,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsOrderActionResult:
    mode = _order_mode(adapter)
    if mode == "live":
        _assert_live_precheck(adapter, policy)
    try:
        return adapter.cancel_order(order_id, mode=mode, live_policy=policy if mode == "live" else None)
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    except (RuntimeError, OSError) as exc:
        log.error("TWS cancel failed for order %s: %s", order_id, exc)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "unknown_outcome",
                "message": "Cancel failed unexpectedly. Refresh Open Orders before retrying.",
            },
        )


@router.patch("/orders/{order_id}", response_model=TwsOrderActionResult)
async def modify_order(
    order_id: int,
    req: TwsModifyOrderRequest,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsOrderActionResult:
    mode = _order_mode(adapter)
    if mode == "live":
        _assert_live_precheck(adapter, policy)
    try:
        return await adapter.modify_order(order_id, req, mode=mode, live_policy=policy if mode == "live" else None)
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    except TwsAdvancedRejectError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "advanced_reject", "reject": exc.reject.model_dump()},
        )
    except (RuntimeError, OSError) as exc:
        log.error("TWS modify failed for order %s: %s", order_id, exc)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "unknown_outcome",
                "message": "Modify failed unexpectedly. Refresh Open Orders before retrying.",
            },
        )


def _override_codes(req: TwsOverrideRequest) -> list[str]:
    codes = [c.strip() for c in req.override_codes if c.strip()]
    if not codes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "override_codes_required"},
        )
    return codes


@router.post("/orders/override", response_model=TwsOrderActionResult)
async def override_order(
    req: TwsOverrideRequest,
    svc: ExecutionPlanService = Depends(get_execution_plan_service),
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsOrderActionResult:
    mode = _order_mode(adapter)
    if mode == "live":
        _assert_live_precheck(adapter, policy)
    try:
        codes = _override_codes(req)
        if req.intent == "place":
            if req.plan_id is None:
                raise HTTPException(status_code=422, detail={"error": "plan_id_required"})
            plan = svc.get(req.plan_id)
            if plan is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail={"error": "plan_not_found", "plan_id": req.plan_id},
                )
            submission = await adapter.place_order(
                plan, mode=mode, live_policy=policy if mode == "live" else None, advanced_override=codes
            )
            return TwsOrderActionResult(
                order_id=submission.order_id,
                status=submission.status,
                action="override",
                message="Override order sent to TWS.",
            )
        if req.order_id is None or req.modify is None:
            raise HTTPException(
                status_code=422,
                detail={"error": "modify_override_requires_order_id_and_modify"},
            )
        return await adapter.modify_order(
            req.order_id, req.modify, mode=mode, live_policy=policy if mode == "live" else None, advanced_override=codes
        )
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    except TwsAdvancedRejectError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "advanced_reject", "reject": exc.reject.model_dump()},
        )
    except (RuntimeError, OSError) as exc:
        log.error("TWS override failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "unknown_outcome",
                "message": "Override failed unexpectedly. Refresh Open Orders before retrying.",
            },
        )


# ── Advanced order packages (Mission 2) ──────────────────────────────────────

def _validated_package_preview(req: TwsOrderPackageRequest) -> TwsOrderPackagePreview:
    try:
        return preview_order_package(req)
    except TwsOrderPackageValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "invalid_order_package", "errors": exc.errors},
        )


@router.post("/order-packages/preview", response_model=TwsOrderPackagePreview)
async def preview_order_package_endpoint(req: TwsOrderPackageRequest) -> TwsOrderPackagePreview:
    return _validated_package_preview(req)


def _package_unknown_outcome(package_id: str, exc: Exception) -> HTTPException:
    log.error("Order package placement failed for package %s: %s", package_id, exc)
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error": "unknown_outcome",
            "message": (
                "Order package placement failed unexpectedly. Check TWS Open Orders "
                "before retrying — some legs may have reached TWS."
            ),
        },
    )


@router.post("/order-packages/place-paper", response_model=TwsOrderPackageSubmission)
async def place_paper_order_package(
    req: TwsOrderPackageRequest,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
) -> TwsOrderPackageSubmission:
    # The broker order graph is always rebuilt from the validated request here —
    # never trust a client-supplied TwsOrderPackagePreview for submission.
    preview = _validated_package_preview(req)
    try:
        return await adapter.place_order_package(preview, mode="paper")
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    except TwsAdvancedRejectError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "advanced_reject", "reject": exc.reject.model_dump()},
        )
    except (RuntimeError, OSError, ConnectionError, TimeoutError) as exc:
        raise _package_unknown_outcome(preview.package_id, exc)


@router.post("/order-packages/place-live", response_model=TwsOrderPackageSubmission)
async def place_live_order_package(
    req: TwsOrderPackageRequest,
    adapter: TwsBrokerAdapter = Depends(get_tws_adapter),
    policy: TwsLivePolicyService = Depends(get_tws_live_policy),
) -> TwsOrderPackageSubmission:
    try:
        policy.assert_live_allowed(
            account_id=adapter.connected_account_id(),
            host=adapter.connected_host(),
            port=adapter.connected_port(),
            is_connected=adapter.is_connected(),
            is_paper_port=adapter.is_paper_port(),
        )
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    preview = _validated_package_preview(req)
    try:
        return await adapter.place_order_package(preview, mode="live", live_policy=policy)
    except TwsPlaceOrderGuardError as exc:
        raise _guard_http_error(exc)
    except TwsAdvancedRejectError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "advanced_reject", "reject": exc.reject.model_dump()},
        )
    except (RuntimeError, OSError, ConnectionError, TimeoutError) as exc:
        raise _package_unknown_outcome(preview.package_id, exc)
