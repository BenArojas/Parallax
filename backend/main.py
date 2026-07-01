"""
Orbit backend — FastAPI application entrypoint.

This is the Python sidecar that Tauri launches automatically.
It owns all communication with IBKR, Ollama, and SQLite.
The React frontend talks exclusively to this server.

Run in dev mode:
    cd backend
    uv run uvicorn main:app --reload --port 8000
"""

import logging

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware

from config import FRONTEND_ORIGIN, TAURI_ORIGIN, REQUEST_LOG_ENABLED
from exceptions import (
    AIError,
    GatewayError,
    IBKRAuthError,
    IBKRConnectionError,
    IBKRRateLimitError,
    IBKRRequestError,
    OllamaConnectionError,
    ParallaxError,
    ScreenerError,
)
from services.broker_session import BrokerSessionService
from services.execution_plan import ExecutionPlanService
from services.tws_broker_adapter import TwsBrokerAdapter
from services.tws_live_policy import TwsLivePolicyService
from services.db import DatabaseService
from services.templates import seed_builtin_templates
from services.gateway import GatewayLifecycle
from services.ibkr import IBKRService
from services.screener import ScreenerService
from services.sectors import SectorService
from services.ai import AiService
from services.ai_analysis_preparation import AIAnalysisPreparationService
from services.ai_providers import AIProviderRegistry, OllamaLLMProvider
from services.ollama import OllamaLifecycle
from services.ollama_context import OllamaContextService
from services.scanner import ScannerService
from services.moonmarket import MoonMarketService
from services.inflect.service import InflectService
from services.inflect_sync import InflectSyncService
from services.inflect_backfill import InflectBackfillService

# ── Logging setup (must be first) ────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
# httpx logs every upstream request at INFO, including the expected 401s from
# IBKR /iserver/auth/status when the user is not logged into Client Portal.
# Those are handled correctly by IBKRService; suppress the access-log spam.
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("parallax")

# ── App version ──────────────────────────────────────────────

APP_VERSION = "0.1.0"


# ── Lifespan (startup / shutdown) ────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Creates the IBKR service singleton on startup.
    Cleans everything up on shutdown.
    """
    log.info("Orbit backend starting (v%s)...", APP_VERSION)

    # Gateway lifecycle — provision JRE + IBKR Gateway, manage process
    # Must start before IBKRService since IBKR talks to the running Gateway.
    # On first launch with no provisioned files, it stays in NOT_PROVISIONED
    # and the frontend triggers /gateway/provision to show progress UI.
    gateway = GatewayLifecycle()
    app.state.gateway = gateway
    try:
        await gateway.startup(auto_start=True)
        log.info("Gateway state: %s", gateway.state.value)
    except GatewayError as e:
        log.warning("Gateway startup: %s (non-fatal, user can set up later)", e.message)

    # Create the IBKR service and stash it on app.state
    ibkr = IBKRService()
    app.state.ibkr = ibkr

    # TWS broker adapter — owns the ib_async IB connection; starts disconnected.
    # Must be created before BrokerSessionService so mode can be derived from it.
    tws_adapter = TwsBrokerAdapter()
    app.state.tws_adapter = tws_adapter

    # Broker session — mode derived from tws_adapter.is_connected() + ibkr auth.
    broker_session = BrokerSessionService(ibkr, tws_adapter)
    app.state.broker_session = broker_session

    # Execution plan service — process-local draft store; lost on restart by design.
    app.state.execution_plan_service = ExecutionPlanService()

    # TWS live policy — process-local allowlist and arm state; lost on restart by design.
    app.state.tws_live_policy = TwsLivePolicyService()

    # Initialize SQLite database (Step 1.4)
    db = DatabaseService()
    await db.initialize()
    await db.seed_defaults()
    await seed_builtin_templates(db)
    app.state.db = db

    # Phase 8 / Task 1.5: wire the SQLite conid cache into IBKRService.
    # Must come AFTER db.initialize() so the conid_cache table exists.
    ibkr.set_db(db)

    # Create the sector service singleton (Step 3.3–3.4)
    # Must be a singleton so the conid cache persists across requests
    app.state.sectors = SectorService(ibkr)

    # Screener service (Phase 5)
    app.state.screener = ScreenerService(ibkr)

    # Ollama lifecycle — detect binary, start server, list models (Step 4.12)
    # This NEVER downloads or installs anything. It detects what the user
    # already has, starts the Ollama server if present, and lists models.
    # If Ollama isn't installed, the frontend shows a setup guide with links.
    ollama = OllamaLifecycle()
    app.state.ollama = ollama

    # Run startup: detect → start server → check models → restore selection.
    # This is fast (no downloads) so we run it inline, not in background.
    saved_model = await db.get_setting("ai_model")
    try:
        await ollama.startup(saved_model=saved_model)
        if ollama.status()["ready"]:
            log.info("Ollama ready — AI features available (model: %s)", ollama.selected_model)
        else:
            log.info("Ollama state: %s — frontend will guide setup", ollama.state.value)
    except (OllamaConnectionError, AIError, OSError) as e:
        log.error("Ollama startup failed: %s", e)

    # AI service — stateless wrapper for Ollama chat/analysis.
    # The model name is passed per-request from ollama.selected_model.
    # OllamaContextService queries /api/show to get the true context-window
    # ceiling per model and caches it, so the prompt truncator uses an
    # accurate budget instead of the static tier table.
    ollama_context = OllamaContextService(ollama)
    ai_provider_registry = AIProviderRegistry({
        "ollama": OllamaLLMProvider(),
    })
    app.state.ai_provider_registry = ai_provider_registry
    ai = AiService(
        context_service=ollama_context,
        provider_registry=ai_provider_registry,
    )
    app.state.ai = ai
    app.state.ai_analysis_preparation = AIAnalysisPreparationService()

    # Background trigger scanner (Phase 6.1 / 6.2)
    # Evaluates active trigger rules every N minutes while the app is open.
    scanner = ScannerService(ibkr=ibkr, db=db)
    app.state.scanner = scanner

    # Wire scanner hits → WebSocket broadcast so the frontend can show
    # desktop notifications and update the alert log in real time (Phase 6.5).
    # Import inside lifespan to avoid circular module-level deps.
    from routers.ws import broadcast as ws_broadcast

    async def _on_trigger_fired(
        hit_id: int,
        rule: dict,
        target: dict,
        condition_values: list[dict],
    ) -> None:
        await ws_broadcast({
            "type": "trigger_alert",
            "hit_id": hit_id,
            "rule_id": rule["id"],
            "rule_name": rule.get("name"),
            "symbol": target.get("symbol", ""),
            "conid": target["conid"],
            "watchlist_name": rule.get("watchlist_name"),
            "ibkr_mirror_target": rule.get("ibkr_mirror_target"),
            "condition_values": condition_values,
        })

    scanner.on_trigger_fired = _on_trigger_fired
    scanner.start()

    # Inflect background fills-sync (keeps the durable `fills` projection fresh
    # inside IBKR's 7-day window while the app is open). Auth-gated, extended-
    # hours-gated; modeled on the scanner's lifecycle.
    inflect_service = InflectService(
        ibkr=ibkr, db=db, moonmarket=MoonMarketService(ibkr)
    )
    inflect_sync = InflectSyncService(ibkr=ibkr, inflect=inflect_service)
    app.state.inflect_sync = inflect_sync
    inflect_sync.start()

    inflect_backfill = InflectBackfillService(
        ibkr=ibkr, db=db, inflect=inflect_service
    )
    app.state.inflect_backfill = inflect_backfill
    inflect_backfill.start()

    log.info("Backend ready. Waiting for frontend connections.")
    yield

    # Shutdown
    log.info("Orbit backend shutting down...")
    await tws_adapter.disconnect()
    await inflect_backfill.stop()
    await inflect_sync.stop()
    await scanner.stop()
    await ai.shutdown()
    await ollama.shutdown()
    await db.close()
    await ibkr.shutdown()
    await gateway.shutdown()
    log.info("Shutdown complete.")


# ── FastAPI app ──────────────────────────────────────────────

APP_DESCRIPTION = """
Orbit is a local-first trading **decision-support** backend.

⚠️ **Safety:** Orbit is decision support, not an autonomous trading bot. It never
places or executes orders on its own — every broker action requires explicit
human confirmation. All broker, AI, and persistence access flows through this
backend. Machine-readable policy: `GET /.well-known/agent.json`.

**Modules**
- **Parallax** — technical analysis, screening, watchlists, alerts.
- **MoonMarket** — portfolio, account, options, human-confirmed order workflows.
- **Inflect** — trading journal and trade review.

Use `conid` across module boundaries; ticker text is display metadata only.
Agent briefing: see `llms.txt` in the repository root.
"""

app = FastAPI(
    title="Orbit",
    version=APP_VERSION,
    summary="Local-first trading decision-support backend. Never trades autonomously.",
    description=APP_DESCRIPTION,
    contact={"name": "Orbit", "url": "https://github.com/BenArojas/orbit"},
    license_info={"name": "See repository LICENSE"},
    openapi_tags=[
        {
            "name": "agent",
            "description": "Discovery + capability/safety manifest for agents connecting to the backend.",
        }
    ],
    lifespan=lifespan,
)


# ── CORS ─────────────────────────────────────────────────────

# Allow all three origins so the same binary works in dev (localhost:1420 or
# 127.0.0.1:1420) and in the packaged Tauri app (tauri://localhost).
# Using a set to dedup in case FRONTEND_ORIGIN is already one of the aliases.
_cors_origins = list({FRONTEND_ORIGIN, TAURI_ORIGIN, "http://127.0.0.1:1420"})

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request-logging middleware (Phase 8 / Task 4.2) ──────────
# Default on in dev (BACKEND_PORT == 8000), off in packaged builds.
# Override with PARALLAX_REQUEST_LOG=1 or =0.

if REQUEST_LOG_ENABLED:
    from request_logging import RequestLoggingMiddleware
    app.add_middleware(RequestLoggingMiddleware)
    log.info("Request logging enabled → backend/logs/requests.log")
else:
    log.debug("Request logging disabled (PARALLAX_REQUEST_LOG=0 or packaged build)")


# ── Exception handlers ───────────────────────────────────────
# These turn our typed exceptions into proper HTTP responses.


@app.exception_handler(IBKRAuthError)
async def ibkr_auth_error_handler(request: Request, exc: IBKRAuthError):
    return JSONResponse(
        status_code=401,
        content={
            "error": "ibkr_auth_error",
            "message": exc.message,
        },
    )


@app.exception_handler(IBKRConnectionError)
async def ibkr_connection_error_handler(request: Request, exc: IBKRConnectionError):
    return JSONResponse(
        status_code=502,
        content={
            "error": "ibkr_connection_error",
            "message": exc.message,
        },
    )


@app.exception_handler(IBKRRateLimitError)
async def ibkr_rate_limit_error_handler(request: Request, exc: IBKRRateLimitError):
    headers = {}
    if exc.retry_after:
        headers["Retry-After"] = str(exc.retry_after)
    return JSONResponse(
        status_code=429,
        content={
            "error": "rate_limit_exceeded",
            "message": exc.message,
            "endpoint": exc.endpoint,
            "retry_after": exc.retry_after,
        },
        headers=headers,
    )


@app.exception_handler(IBKRRequestError)
async def ibkr_request_error_handler(request: Request, exc: IBKRRequestError):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": "ibkr_request_error",
            "message": exc.message,
        },
    )


@app.exception_handler(OllamaConnectionError)
async def ollama_connection_error_handler(request: Request, exc: OllamaConnectionError):
    return JSONResponse(
        status_code=503,
        content={
            "error": "ollama_connection_error",
            "message": exc.message,
        },
    )


@app.exception_handler(AIError)
async def ai_error_handler(request: Request, exc: AIError):
    return JSONResponse(
        status_code=500,
        content={
            "error": "ai_error",
            "message": exc.message,
        },
    )


@app.exception_handler(ScreenerError)
async def screener_error_handler(request: Request, exc: ScreenerError):
    return JSONResponse(
        status_code=422,
        content={
            "error": "screener_error",
            "message": exc.message,
        },
    )


@app.exception_handler(GatewayError)
async def gateway_error_handler(request: Request, exc: GatewayError):
    return JSONResponse(
        status_code=502,
        content={
            "error": "gateway_error",
            "message": exc.message,
        },
    )


@app.exception_handler(ParallaxError)
async def parallax_error_handler(request: Request, exc: ParallaxError):
    """Catch-all for any ParallaxError subclass not handled above."""
    return JSONResponse(
        status_code=500,
        content={
            "error": "parallax_error",
            "message": exc.message,
        },
    )


# ── Routers ──────────────────────────────────────────────────

from routers.auth import router as auth_router
from routers.indicators import router as indicators_router
from routers.market import router as market_router
from routers.sectors import router as sectors_router
from routers.watchlist import router as watchlist_router
from routers.ws import router as ws_router

app.include_router(auth_router)
app.include_router(indicators_router)
app.include_router(market_router)
app.include_router(sectors_router)
app.include_router(watchlist_router)
app.include_router(ws_router)

from routers.triggers import router as triggers_router
from routers.ai import router as ai_router
from routers.fibonacci import router as fibonacci_router

app.include_router(triggers_router)
app.include_router(ai_router)
app.include_router(fibonacci_router)

from routers.screener import router as screener_router
app.include_router(screener_router)

from routers.gateway import router as gateway_router
app.include_router(gateway_router)

from routers.watchlist_config import router as watchlist_config_router
app.include_router(watchlist_config_router)

# Phase 6.5 settings router — was authored but never registered here,
# so every `PUT /settings/{key}` from the frontend was silently 404-ing
# before Phase 8.9+. Fixed alongside the pulse-config work.
from routers.settings import router as settings_router
app.include_router(settings_router)

from routers.pulse_config import router as pulse_config_router
app.include_router(pulse_config_router)

from routers.health import router as health_router
app.include_router(health_router)

from routers.instruments import router as instruments_router
app.include_router(instruments_router)

from routers.drawings import router as drawings_router
app.include_router(drawings_router)

from routers.moonmarket import router as moonmarket_router
app.include_router(moonmarket_router)

from routers.orders import router as orders_router
app.include_router(orders_router)

from routers.trading_safety import router as trading_safety_router
app.include_router(trading_safety_router)

from routers.options import router as options_router
app.include_router(options_router)

from routers.inflect import router as inflect_router
app.include_router(inflect_router)

from routers.agent import router as agent_router
app.include_router(agent_router)

from routers.orbit_session import router as orbit_session_router
app.include_router(orbit_session_router)

from routers.execution_assistant import router as execution_assistant_router
app.include_router(execution_assistant_router)

from routers.tws_stream import router as tws_stream_router
app.include_router(tws_stream_router)

# Routers exposed for in-process reuse (the read-only MCP server + its tests).
ALL_ROUTERS = [
    auth_router, indicators_router, market_router, sectors_router, watchlist_router,
    ws_router, triggers_router, ai_router, fibonacci_router, screener_router,
    gateway_router, watchlist_config_router, settings_router, pulse_config_router,
    health_router, instruments_router, drawings_router, moonmarket_router,
    orders_router, trading_safety_router, options_router, inflect_router, agent_router,
    orbit_session_router, execution_assistant_router, tws_stream_router,
]


# ── Read-only MCP server ─────────────────────────────────────
# Mounted in-process on the existing sidecar at /mcp-server/mcp (streamable-http).
# Strictly read-only (see mcp_server.py / test_mcp_readonly.py). The MCP ASGI app
# has its own lifespan, so it MUST be merged with Orbit's lifespan or one of the
# two startup paths is silently skipped.
from fastmcp.utilities.lifespan import combine_lifespans
from mcp_server import build_mcp

_mcp_app = build_mcp(app).http_app(path="/mcp")
app.router.lifespan_context = combine_lifespans(lifespan, _mcp_app.lifespan)
app.mount("/mcp-server", _mcp_app)


# ── Health endpoint ──────────────────────────────────────────

@app.get("/health")
async def health(request: Request):
    """
    Health check — frontend calls this to verify the backend is alive.
    Also reports IBKR connection status so the UI can show appropriate state.
    """
    ibkr: IBKRService = request.app.state.ibkr
    gw: GatewayLifecycle = request.app.state.gateway
    return {
        "status": "ok" if ibkr.state.authenticated else "degraded",
        "ibkr_connected": ibkr.state.authenticated,
        "ibkr_authenticated": ibkr.state.authenticated,
        "ws_ready": ibkr.state.ws_connected,
        "gateway_running": gw.state.value == "running",
        "gateway_state": gw.state.value,
        "version": APP_VERSION,
    }
