# TWS Market-Data Extras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow `docs/testing.md` for test scope — this repo defaults to zero new tests per slice, not TDD red/green cycles; add a focused test only where a step's own checklist says to.

**Goal:** Mission 3 of the TWS Execution Assistant — a read-only, TWS-owned websocket stream for live quotes, in-progress candle updates, Level 2/depth, and per-exchange entitlement guidance, per the approved parent design (`docs/superpowers/specs/2026-06-29-tws-live-advanced-market-data-design.md`).

**Architecture:** One new FastAPI native WebSocket endpoint (`/execution-assistant/ws`), fed by `ib_async` live subscriptions inside `TwsBrokerAdapter` (`reqMktData(snapshot=False)` for quotes/entitlement, `reqHistoricalDataAsync(keepUpToDate=True)` for the active candle, `reqMktDepth` for Level 2), translated into four typed JSON events and broadcast to subscribed clients. Frontend adds a new singleton WebSocket module mirroring the existing `src/hooks/useWebSocket.ts` pattern (backoff, ref-counting, auto-resubscribe) — a separate connection from the existing Client Portal `/ws`, not a shared one. Live data layers on top of the existing REST polling (`getQuote`/`getBars`) rather than replacing it, so the cockpit degrades gracefully if the stream drops.

**Tech Stack:** FastAPI native `WebSocket`, `ib_async` 2.1.0 behind `TwsBrokerAdapter`, React 19, TypeScript, TanStack Query (kept for bootstrap/entitlement REST), native browser `WebSocket` API on the frontend (no new dependency).

---

## Global Constraints

- Orbit remains decision support, never autonomous trading; this mission is read-only — no order-mutation code paths anywhere in it.
- `ib_async` types (`Ticker`, `Contract`, `BarDataList`, etc.) must never leak outside `TwsBrokerAdapter`.
- No persistence beyond current session state — subscriptions and last-tick state live in memory only, cleared on adapter disconnect or socket close.
- Market-data failures (entitlement errors, stream drops, subscribe rejections) must never block cancel/modify or any existing safety action — this mission adds no new coupling to those code paths.
- No subscription/account-setting automation (Human Approval Gate in the parent spec) — entitlement guidance is informational text only, never an action button that changes IBKR account settings.
- The new `/execution-assistant/ws` endpoint is separate from the existing Client Portal `/ws` (`backend/routers/ws.py`) — do not modify or share any state with it.
- New frontend WebSocket module follows `src/hooks/useWebSocket.ts`'s pattern (singleton, ref-counted, exponential backoff 1s→2s→4s→30s, type-discriminator message envelope) but as its own separate module — do not extend `useWebSocket.ts` to multiplex two different backend servers.
- Use `conid` as the subscription key across the boundary everywhere; never ticker text.
- Before writing any `ib_async` call this plan specifies, verify its signature against this repo's installed version with a one-line `uv run python -c "..."` check (mirrors how Task 6 of the advanced-order-types mission verified `PriceCondition` before using it) — do not assume signatures from memory.

## File Map

- Modify `backend/models/tws_execution_assistant.py`: add `"partial"` to the existing `MarketDataType` literal, add `TwsTimeframe`, four typed stream-event models, one control-message model.
- Modify `backend/services/tws_broker_adapter.py`: `classify_entitlement()` helper (extracted from the existing `get_quote()` 10089/10090 handling for reuse), `subscribe_quote`/`unsubscribe_quote`, `subscribe_bars`/`unsubscribe_bars`, `subscribe_depth`/`unsubscribe_depth`.
- Create `backend/routers/tws_stream.py`: the `/execution-assistant/ws` route — accepts the connection, reads subscribe/unsubscribe control messages, forwards adapter events to the socket, tears down subscriptions on disconnect.
- Modify `backend/main.py` (or wherever routers are registered — check the existing `app.include_router(ea_router)` call site): mount the new stream router.
- Test: `backend/tests/test_execution_assistant_stream.py` (new, minimal per `docs/testing.md`).
- Modify `src/config/endpoints.ts`: add the new TWS stream WebSocket URL constant.
- Create `src/modules/tws-execution-assistant/useTwsLiveStream.ts`: singleton WebSocket client for `/execution-assistant/ws`.
- Create `src/modules/tws-execution-assistant/useTwsStreamChannel.ts`: generic channel hook for quote/bars/depth subscriptions.
- Create `src/modules/tws-execution-assistant/useTwsLiveQuote.ts`: one-line wrapper around `useTwsStreamChannel("quote", conid)`.
- Create `src/modules/tws-execution-assistant/useTwsLiveBars.ts`: one-line wrapper around `useTwsStreamChannel("bars", conid, timeframe)`.
- Create `src/modules/tws-execution-assistant/useTwsLiveDepth.ts`: one-line wrapper around `useTwsStreamChannel("depth", conid)`.
- Create `src/modules/tws-execution-assistant/DepthPanel.tsx`: Level-2 book display with a visible unavailable state.
- Modify `src/modules/tws-execution-assistant/api.ts`: TypeScript types mirroring the four backend event models.
- Modify `src/modules/tws-execution-assistant/TwsCandleChart.tsx`: accept an optional `liveBar` prop to patch the last candle instead of only replacing the whole `bars` array.
- Modify `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`: wire the live quote/bars/depth hooks into the existing quote strip/chart, mount `DepthPanel`, surface per-exchange entitlement guidance text.

## Interfaces

```python
# backend/models/tws_execution_assistant.py additions/changes

MarketDataType = Literal[
    "unknown",
    "live",
    "frozen",
    "delayed",
    "delayed_frozen",
    "unavailable",
    "partial",
]

TwsTimeframe = Literal["1m", "5m", "15m", "30m", "4h", "1D", "1W"]

class TwsStreamSubscribeRequest(BaseModel):
    action: Literal["subscribe", "unsubscribe"]
    channel: Literal["quote", "bars", "depth"]
    conid: int
    timeframe: TwsTimeframe | None = None  # required when channel == "bars"

class TwsStreamStatusEvent(BaseModel):
    type: Literal["tws_stream_status"] = "tws_stream_status"
    connected: bool
    reason: str | None = None

class TwsStreamErrorEvent(BaseModel):
    type: Literal["tws_stream_error"] = "tws_stream_error"
    message: str

class TwsQuoteStreamEvent(BaseModel):
    type: Literal["tws_quote"] = "tws_quote"
    conid: int
    last: float | None = None
    bid: float | None = None
    ask: float | None = None
    bid_size: float | None = None
    ask_size: float | None = None
    high: float | None = None
    low: float | None = None
    volume: float | None = None
    entitlement: MarketDataType
    unavailable_reason: str | None = None

class TwsBarUpdateEvent(BaseModel):
    type: Literal["tws_bar_update"] = "tws_bar_update"
    conid: int
    timeframe: TwsTimeframe
    bar: BarSnapshot

class TwsDepthLevel(BaseModel):
    price: float
    size: float
    market_maker: str | None = None

class TwsDepthUpdateEvent(BaseModel):
    type: Literal["tws_depth_update"] = "tws_depth_update"
    conid: int
    bids: list[TwsDepthLevel]
    asks: list[TwsDepthLevel]
    entitlement: MarketDataType
    unavailable_reason: str | None = None
```

```ts
// src/modules/tws-execution-assistant/api.ts additions/changes
export type MarketDataType =
  | "unknown"
  | "live"
  | "frozen"
  | "delayed"
  | "delayed_frozen"
  | "unavailable"
  | "partial";

export type TwsTimeframe = "1m" | "5m" | "15m" | "30m" | "4h" | "1D" | "1W";

export interface TwsStreamStatusEvent { type: "tws_stream_status"; connected: boolean; reason: string | null }
export interface TwsStreamErrorEvent { type: "tws_stream_error"; message: string }
export interface TwsQuoteStreamEvent {
  type: "tws_quote"; conid: number;
  last: number | null; bid: number | null; ask: number | null;
  bid_size: number | null; ask_size: number | null;
  high: number | null; low: number | null; volume: number | null;
  entitlement: MarketDataType; unavailable_reason: string | null;
}
export interface TwsBarUpdateEvent { type: "tws_bar_update"; conid: number; timeframe: TwsTimeframe; bar: BarSnapshot }
export interface TwsDepthLevel { price: number; size: number; market_maker: string | null }
export interface TwsDepthUpdateEvent { type: "tws_depth_update"; conid: number; bids: TwsDepthLevel[]; asks: TwsDepthLevel[]; entitlement: MarketDataType; unavailable_reason: string | null }
export type TwsStreamEvent = TwsStreamStatusEvent | TwsStreamErrorEvent | TwsQuoteStreamEvent | TwsBarUpdateEvent | TwsDepthUpdateEvent;
```

Verified `ib_async` signatures this plan builds against (installed version in `backend/.venv`):

```
reqMktData(contract, genericTickList="", snapshot=False, regulatorySnapshot=False, mktDataOptions=[]) -> Ticker
cancelMktData(contract) -> bool
reqMktDepth(contract, numRows=5, isSmartDepth=False, mktDepthOptions=None) -> Ticker
cancelMktDepth(contract, isSmartDepth=False)
reqHistoricalDataAsync(contract, endDateTime, durationStr, barSizeSetting, whatToShow, useRTH, formatDate=1, keepUpToDate=False, chartOptions=[], timeout=60) -> BarDataList
cancelHistoricalData(bars: BarDataList)
IB.errorEvent
IB.disconnectedEvent    # emits with no args
IB.connectedEvent       # emits with no args
Ticker.updateEvent       # fires per-ticker on that ticker's own update
IB.barUpdateEvent        # emits (bars, hasNewBar) for reqHistoricalDataAsync(..., keepUpToDate=True)
BarDataList.updateEvent  # each BarDataList also has its own per-subscription updateEvent
```

---

### Task 0: Record Mission 3 Kickoff

**Files:**
- Modify: `PROJECT_PLAN.md`
- Modify: `docs/superpowers/specs/2026-06-29-tws-live-advanced-market-data-design.md`

- [ ] In `PROJECT_PLAN.md`'s TWS follow-up missions bullet, change "(3) **Market-data extras** — pending" to "IN PROGRESS on `feature/tws-live-advanced-market-data-design`" and add the plan file path.
- [ ] Add a dated note under `docs/superpowers/specs/2026-06-29-tws-live-advanced-market-data-design.md`'s Mission 3 section pointing at this plan file.
- [ ] Run:

```bash
git diff --check
```

- [ ] Commit:

```bash
git add PROJECT_PLAN.md docs/superpowers/specs/2026-06-29-tws-live-advanced-market-data-design.md
git commit -m "docs: start tws market-data extras mission"
```

### Task 1: Entitlement Classification Helper

**Files:**
- Modify: `backend/models/tws_execution_assistant.py`
- Modify: `backend/services/tws_broker_adapter.py:314-397` (existing `get_quote()`)
- Test: `backend/tests/test_execution_assistant_stream.py`

**Interfaces:**
- Adds `"partial"` to the existing `MarketDataType` literal in `backend/models/tws_execution_assistant.py:119` and `src/modules/tws-execution-assistant/api.ts:189-195`.

- [ ] Add `"partial"` to `MarketDataType`; stream event `entitlement` fields use `MarketDataType`, not a separate entitlement type.
- [ ] In `tws_broker_adapter.py`, extract a new method:

```python
def _classify_entitlement(
    self, market_data_type_code: int | None, error_code: int | None,
) -> tuple[MarketDataType, str | None]:
    """Maps an ib_async marketDataType tick + any captured MDT error code to
    (entitlement_state, unavailable_reason). Shared by the REST snapshot path
    (get_quote) and the new live-stream path so both classify the same way."""
    if error_code == 10089:
        return "unavailable", "API market data subscription required; delayed market data may be available."
    if error_code == 10090:
        return "partial", "Partial market data subscription — some fields may be missing."
    return _MDT_MAP.get(market_data_type_code, "unknown"), None
```

  Note: `_MDT_MAP` already exists at module level (`{1: "live", 2: "frozen", 3: "delayed", 4: "delayed_frozen"}`) — reuse it, do not redefine. `"unknown"` is a legitimate `MarketDataType` because `marketDataType=0` happens in practice; no `type: ignore` is needed.
- [ ] Update `get_quote()` (lines ~383-389) to call `self._classify_entitlement(...)` instead of its inline 10089-only check, so the "partial" (10090) case is now handled there too where it wasn't before.
- [ ] Add one focused test in `test_execution_assistant_stream.py` covering the previously-uncovered `10090 → "partial"` branch through the highest practical public boundary: `get_quote()` with a mocked 10090 error should return a `QuoteSnapshot` whose `market_data_type` is `"partial"` (the `10089 → "unavailable"` branch is already covered by existing `get_quote` tests — do not duplicate). Prefer this over calling `_classify_entitlement()` directly.

```python
async def test_get_quote_maps_10090_to_partial(...):
    ...
    quote = await adapter.get_quote(conid=123)
    assert quote.market_data_type == "partial"
```

- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_stream.py tests/test_execution_assistant_connect.py -q
```

- [ ] Commit:

```bash
git add backend/models/tws_execution_assistant.py backend/services/tws_broker_adapter.py backend/tests/test_execution_assistant_stream.py
git commit -m "feat: extract shared tws entitlement classification helper"
```

### Task 2: WebSocket Connection, Subscribe/Unsubscribe, Stream Status

**Files:**
- Create: `backend/routers/tws_stream.py`
- Modify: `backend/main.py` (router registration — confirm exact call site first)
- Modify: `backend/services/tws_broker_adapter.py`
- Modify: `src/config/endpoints.ts`
- Create: `src/modules/tws-execution-assistant/useTwsLiveStream.ts`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- Adds `TwsStreamSubscribeRequest`, `TwsStreamStatusEvent`, `TwsStreamErrorEvent` (see Interfaces section).

- [ ] Add `TwsTimeframe = Literal["1m", "5m", "15m", "30m", "4h", "1D", "1W"]` to `backend/models/tws_execution_assistant.py`; use it for `TwsStreamSubscribeRequest.timeframe` so pydantic rejects bad subscribes for free. `_ALLOWED_TIMEFRAMES` at `backend/routers/execution_assistant.py:178` can be derived from it.
- [ ] Add a bare per-connection subscription registry to `TwsBrokerAdapter` — a `dict[WebSocket, dict[int, set[str]]]` keyed by socket, then conid, then channel keys (`"quote"`, `"bars:1m"`, `"depth"`). Keep it as a plain instance attribute, not persisted. Before any `cancel*` call, check no other socket still holds the same `(channel, conid)` subscription.
- [ ] In `backend/routers/tws_stream.py`, add the route:

```python
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from services.tws_broker_adapter import TwsBrokerAdapter
from models.tws_execution_assistant import TwsStreamErrorEvent, TwsStreamSubscribeRequest, TwsStreamStatusEvent

router = APIRouter()

@router.websocket("/execution-assistant/ws")
async def tws_stream(websocket: WebSocket):
    adapter: TwsBrokerAdapter = websocket.app.state.tws_adapter
    await websocket.accept()
    await websocket.send_json(TwsStreamStatusEvent(connected=adapter.is_connected()).model_dump())
    try:
        while True:
            try:
                raw = await websocket.receive_json()
                req = TwsStreamSubscribeRequest(**raw)
                if req.action == "subscribe":
                    await adapter.stream_subscribe(websocket, req)
                else:
                    await adapter.stream_unsubscribe(websocket, req)
            except (ValueError, ValidationError) as exc:
                await websocket.send_json(TwsStreamErrorEvent(message=str(exc)).model_dump())
    except WebSocketDisconnect:
        pass
    finally:
        adapter.stream_cleanup(websocket)
```

  Get the adapter via `websocket.app.state.tws_adapter` (mirror `backend/routers/ws.py:79`). `Depends(get_tws_adapter)` cannot work in a websocket route because `get_tws_adapter` declares `request: Request`. The receive loop must catch JSON decode errors and pydantic `ValidationError`, answer with a typed error event (or log and skip), and always run `stream_cleanup(websocket)` in `finally` so no `ib_async` subscription can leak.
- [ ] Register the router in `backend/main.py` next to the existing `from routers.execution_assistant import router as execution_assistant_router` / `app.include_router(execution_assistant_router)` pair (main.py:475-476) — follow the same import-alias-then-include_router shape for the new `tws_stream` router.
- [ ] Subscribe `self._ib.disconnectedEvent` and `self._ib.connectedEvent` once. On disconnect, broadcast `TwsStreamStatusEvent(connected=False)` to all open stream sockets and clear the registry (cancel nothing — `ib_async` subscriptions die with the connection). On connect, broadcast `connected=True`. This implements the "cleared on adapter disconnect" global constraint and the Task 7 smoke check.
- [ ] Create `useTwsLiveStream.ts` mirroring `src/hooks/useWebSocket.ts`'s structure: module-level singleton socket + ref count, exponential backoff (1s→2s→4s→30s cap, same schedule), a `send(msg)` function, and a subscribe-to-messages callback API. Track active subscriptions too (`channel|conid|timeframe` key, with refcounts), replay them on socket open like `src/hooks/useWebSocket.ts:95-102`, and mirror the 10s `TEARDOWN_GRACE_MS` pattern. Import the new WS URL from a constant in `src/config/endpoints.ts`; never hardcode the URL.
- [ ] Implementation note: `eventkit` supports async coroutine handlers directly (`ticker.updateEvent += async_handler` runs on the loop), but they are fire-and-forget. Handlers must guard against sending on a closed/closing websocket, and must be closures or module-level functions; callable objects are weakly referenced and silently auto-disconnect.
- [ ] Mount a minimal connected/disconnected indicator in `TwsExecutionAssistantModule.tsx` (reusing existing status-badge styling) wired to `tws_stream_status` events, so this slice is vertically testable end to end before any real data flows through it.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_stream.py -q
npm run typecheck
```

- [ ] Manual smoke: connect TWS in the app, confirm the new stream-status indicator flips to "connected" without errors in the backend log.
- [ ] Commit:

```bash
git add backend/routers/tws_stream.py backend/main.py backend/services/tws_broker_adapter.py src/config/endpoints.ts src/modules/tws-execution-assistant/useTwsLiveStream.ts src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: add tws market-data websocket connection and stream status"
```

### Task 3: Live Quote Streaming

**Files:**
- Modify: `backend/services/tws_broker_adapter.py`
- Create: `src/modules/tws-execution-assistant/useTwsStreamChannel.ts`
- Create: `src/modules/tws-execution-assistant/useTwsLiveQuote.ts`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- Adds `TwsQuoteStreamEvent` (see Interfaces section).

- [ ] Add `subscribe_quote(websocket, conid)` / `unsubscribe_quote(websocket, conid)` to `TwsBrokerAdapter`: build a `Contract(conId=conid, exchange="SMART", currency="USD", secType="STK")`, call `self._ib.reqMktData(contract, snapshot=False)`, attach a listener on the returned `Ticker.updateEvent` that builds a `TwsQuoteStreamEvent` and pushes it out over the websocket; register `"quote"` for this `conid` in the per-socket registry from Task 2 so `stream_cleanup(websocket)` cancels it on disconnect; on explicit unsubscribe, remove the listener, call `self._ib.cancelMktData(contract)` only if no other socket still holds that quote subscription, and remove the registry entry.
- [ ] Entitlement classification for the stream must be data-first like `get_quote`: under `reqMarketDataType(4)`, 10089 fires as an informational warning while delayed ticks still flow. Classify `"unavailable"` only when no field values have arrived and 10089 was captured. 10090 still maps to `"partial"`.
- [ ] Build the generic `useTwsStreamChannel(channel, conid, timeframe?)` helper now; `useTwsLiveQuote` is a one-line wrapper around it. The helper sends subscribe/unsubscribe through `useTwsLiveStream`, filters incoming events by channel/conid/timeframe, and returns the latest matching event.
- [ ] In `TwsExecutionAssistantModule.tsx`, wire `useTwsLiveQuote(planForm.conid)` alongside the existing `useQuery(["tws-quote", ...])` polling. The live event overlays the poll's `QuoteSnapshot`: keep the poll's `close` because `changePct` needs it, map `entitlement` onto the existing `market_data_type`/`is_delayed` badge logic (`TwsExecutionAssistantModule.tsx:52-53`), and never replace the snapshot wholesale. Do not remove the poll; it's the degrade-gracefully path.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_stream.py -q
npm run typecheck
```

- [ ] Manual smoke: with TWS connected and a symbol resolved, confirm the quote strip updates live (or shows the same "Delayed"/unavailable badge it already shows today if the account lacks a live data subscription — this must not regress the existing delayed-data UX).
- [ ] Commit:

```bash
git add backend/services/tws_broker_adapter.py src/modules/tws-execution-assistant/useTwsStreamChannel.ts src/modules/tws-execution-assistant/useTwsLiveQuote.ts src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: stream live tws quotes into the quote strip"
```

### Task 4: Live Candle Updates

**Files:**
- Modify: `backend/services/tws_broker_adapter.py`
- Create: `src/modules/tws-execution-assistant/useTwsLiveBars.ts`
- Modify: `src/modules/tws-execution-assistant/TwsCandleChart.tsx`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- Adds `TwsBarUpdateEvent` (see Interfaces section).

- [ ] Add `subscribe_bars(websocket, conid, timeframe)` / `unsubscribe_bars(...)`: reuse `self._TF_MAP[timeframe]` for both `barSizeSetting` and `durationStr`; hardcoded `"1 D"` breaks `1W` bars. Call `await self._ib.reqHistoricalDataAsync(contract, endDateTime="", durationStr=<mapped duration>, barSizeSetting=<mapped bar size>, whatToShow="TRADES", useRTH=True, keepUpToDate=True)` — never the sync `reqHistoricalData`, which is blocking and raises inside FastAPI's running loop. Subscribe to the returned `bar_data_list.updateEvent` (per-subscription scoping) instead of filtering the global `IB.barUpdateEvent` by identity, and on each update emit a `TwsBarUpdateEvent` for the last bar in the list. Register `f"bars:{timeframe}"` for this `conid` in the per-socket registry from Task 2. On unsubscribe (explicit or via `stream_cleanup`), cancel via `self._ib.cancelHistoricalData(bar_data_list)` only if no other socket still holds that bars subscription, and remove the registry entry.
- [ ] `useTwsLiveBars(conid, timeframe)`: one-line wrapper around `useTwsStreamChannel("bars", conid, timeframe)`, returning the latest `TwsBarUpdateEvent.bar` for this conid+timeframe.
- [ ] `TwsCandleChart.tsx`: accept an optional `liveBar?: BarSnapshot` prop. Currently this file only calls `candle.setData(candleData)` and `vol.setData(volData)` (full reset, `TwsCandleChart.tsx:101-102`) — do not call `setData` on every live tick. Instead, when `liveBar` changes, call `candleRef.current.update(...)` and patch `volRef.current.update({time, value, color})` from the same bar so the volume histogram does not go stale.
- [ ] Wire `useTwsLiveBars(planForm.conid, activeTimeframe)` in `TwsExecutionAssistantModule.tsx`, passing its result as `TwsCandleChart`'s new `liveBar` prop. Keep the existing `useQuery(["tws-bars", ...])` bootstrap unchanged — it still does the initial historical load.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_stream.py -q
npm run typecheck
```

- [ ] Manual smoke: with a symbol resolved and the market open (or using a symbol with recent trades), confirm the last candle on the chart visibly updates without a full re-render/flicker.
- [ ] Commit:

```bash
git add backend/services/tws_broker_adapter.py src/modules/tws-execution-assistant/useTwsLiveBars.ts src/modules/tws-execution-assistant/TwsCandleChart.tsx src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: stream live tws candle updates into the chart"
```

### Task 5: Level 2 / Depth Panel

**Files:**
- Modify: `backend/services/tws_broker_adapter.py`
- Create: `src/modules/tws-execution-assistant/useTwsLiveDepth.ts`
- Create: `src/modules/tws-execution-assistant/DepthPanel.tsx`
- Modify: `src/modules/tws-execution-assistant/api.ts`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- Adds `TwsDepthLevel`, `TwsDepthUpdateEvent` (see Interfaces section).

- [ ] Add `subscribe_depth(websocket, conid)` / `unsubscribe_depth(...)`: call `self._ib.reqMktDepth(contract, numRows=5)`, listen on the returned `Ticker.updateEvent`, read `ticker.domBids`/`ticker.domAsks` (each a list of `DOMLevel(price, size, marketMaker)`), map to `TwsDepthLevel`, emit `TwsDepthUpdateEvent` with `entitlement="live"` while levels flow. Register `"depth"` for this `conid` in the per-socket registry from Task 2. On unsubscribe (explicit or via `stream_cleanup`), call `self._ib.cancelMktDepth(contract)` only if no other socket still holds that depth subscription, and remove the registry entry.
- [ ] Depth failures never surface via `marketDataType` or 10089/10090: `reqMktDepth` never raises, and an unentitled sub is silently empty `domBids`/`domAsks`; the real error (309/2152/10092/etc.) is emitted only on `IB.errorEvent`. While a depth subscription is active, listen on `ib.errorEvent` filtered by `contract.conId`; on a depth error, emit `TwsDepthUpdateEvent` with `entitlement="unavailable"` and an `unavailable_reason` so `DepthPanel` renders the explicit unavailable state. This implements the design's exchange-specific permission-failure classification.
- [ ] `DepthPanel.tsx`: two columns (bids/asks), 5 rows each, compact (`text-xs`, matches the existing cockpit density). When `entitlement === "unavailable"`, render a single centered line ("Depth data not available for this account/exchange.") instead of empty rows — an explicit unavailable state, not a silent blank panel.
- [ ] `useTwsLiveDepth(conid)`: one-line wrapper around `useTwsStreamChannel("depth", conid)`.
- [ ] Mount `DepthPanel` in `TwsExecutionAssistantModule.tsx` next to the existing bid/ask quote-strip cells, subscribing via `useTwsLiveDepth(conid)`.
- [ ] Run:

```bash
npm run typecheck
```

- [ ] Manual smoke: confirm the depth panel shows real levels for a liquid symbol, and shows the explicit unavailable message for an account without Level 2 entitlement (do not fake success — confirm the actual unavailable path renders correctly).
- [ ] Commit:

```bash
git add backend/services/tws_broker_adapter.py src/modules/tws-execution-assistant/useTwsLiveDepth.ts src/modules/tws-execution-assistant/DepthPanel.tsx src/modules/tws-execution-assistant/api.ts src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: add tws level 2 depth panel"
```

### Task 6: Per-Exchange Entitlement Guidance

**Files:**
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- No new runtime interface — reads `entitlement`/`unavailable_reason` already flowing through `TwsQuoteStreamEvent`/`TwsDepthUpdateEvent` since Tasks 3 and 5.

- [ ] Add a small, dismissible inline note (reusing the existing warning-badge/tooltip pattern already established for package warnings) that appears only when `entitlement` is `"unavailable"` or `"partial"`, showing `unavailable_reason` plain-English text plus the instrument's primary exchange (already available from the resolved `InstrumentResult`). No action button, no link to IBKR account settings, no auto-detection of "which subscription to buy" — informational only, per the parent spec's Human Approval Gate against subscription automation.
- [ ] Run:

```bash
npm run typecheck
```

- [ ] Manual smoke: confirm the guidance note appears/disappears correctly as you switch between symbols with different entitlement states.
- [ ] Commit:

```bash
git add src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: surface per-exchange tws entitlement guidance"
```

### Task 7: Roadmap, Smoke Notes, And Merge-Gate Verification

**Files:**
- Modify: `PROJECT_PLAN.md`

- [ ] Update `PROJECT_PLAN.md`'s Mission 3 entry from IN PROGRESS to DONE, summarizing what shipped.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_stream.py tests/test_execution_assistant_advanced_orders.py tests/test_execution_assistant_reconciliation.py tests/test_execution_assistant_live_policy.py -q
npm run typecheck
git diff --check
```

- [ ] Manual smoke with human present:
  - connect, confirm stream status flips connected/disconnected correctly on TWS disconnect.
  - live quote streaming for a resolved symbol; confirm delayed/unavailable accounts still degrade to the existing REST poll cleanly.
  - live candle update visibly patches the chart's last bar.
  - depth panel shows real levels or the explicit unavailable state.
  - confirm cancel/modify on an existing order still works unaffected while the stream is live (the core "market-data failures never block safety actions" promise).
- [ ] Commit:

```bash
git add PROJECT_PLAN.md
git commit -m "docs: update tws market-data extras status"
```

## Recommended Batches

- **Batch 1 (Tasks 0-2):** doc kickoff, entitlement helper, websocket connection scaffold. Nothing user-visible beyond a connection indicator — safe to review as one unit.
- **Batch 2 (Task 3):** live quotes — the highest-value, most user-visible slice; review alone given it changes the always-on quote strip.
- **Batch 3 (Task 4):** live candles — touches the chart rendering path, review alone.
- **Batch 4 (Tasks 5-6):** depth panel + entitlement guidance — both additive, lower-risk, reviewable together.
- **Batch 5 (Task 7):** final verification, only after a human has done the manual smoke checklist.
