# TWS Advanced Order Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add review-and-send TWS order packages for scale-outs, brackets, trailing stops, good-till-date orders, market-on-close, limit-on-close, and one price-condition slice.

**Architecture:** Add a small TWS order-package contract beside the existing execution assistant models. Keep previews and validation in plain Pydantic/TypeScript contracts, and construct `ib_async.Order` objects only inside `TwsBrokerAdapter`. Package submit uses the existing paper/live mode checks; live submit reuses Mission 1 allowlist and armed-session policy.

**Tech Stack:** FastAPI, Pydantic, `ib_async` 2.1.0 behind `TwsBrokerAdapter`, React 19, TypeScript, TanStack Query.

## Global Constraints

- Orbit remains decision support, never autonomous trading.
- All broker access stays behind FastAPI and `TwsBrokerAdapter`.
- `ib_async` types must not leak into routers, frontend contracts, database models, or module UI.
- No database persistence for package state in this mission.
- Live submit requires the existing allowlisted and armed TWS session, then the adapter rechecks before every `placeOrder` call.
- Staged packages use `transmit=False` until the final child order.
- Scale-out ladders are long-only and must not create accidental short exposure.
- Trailing stops support fixed amount and percent trail.
- Conditional orders are last and narrow: one price condition only.
- Follow `docs/testing.md`: default to zero new tests unless an uncovered critical promise needs one public-boundary test.

---

## File Map

- Modify `backend/models/tws_execution_assistant.py`: request/preview/submission models for order packages.
- Create `backend/services/tws_order_packages.py`: validation and preview builder using plain Python data only.
- Modify `backend/routers/execution_assistant.py`: preview and submit package endpoints.
- Modify `backend/services/tws_broker_adapter.py`: build and submit broker-native TWS orders.
- Modify `backend/tests/test_execution_assistant_advanced_orders.py`: focused public-boundary tests.
- Modify `src/modules/tws-execution-assistant/api.ts`: TypeScript package contracts and API calls.
- Modify `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`: package review/submit UI.
- Modify `PROJECT_PLAN.md`: mark Mission 2 in progress before code and complete after accepted smoke/review.

## Interfaces

Backend model names:

```python
TwsAdvancedOrderKind = Literal[
    "scale_out_ladder", "bracket", "trailing_stop", "gtd", "moc", "loc", "price_condition"
]

class TwsTrailSpec(BaseModel):
    mode: Literal["amount", "percent"]
    value: float

class TwsScaleOutLotDraft(BaseModel):
    quantity: float
    target_price: float
    stop_price: float | None = None
    trail: TwsTrailSpec | None = None
    close_fallback: Literal["MOC"] = "MOC"

class TwsOrderPackageRequest(BaseModel):
    kind: TwsAdvancedOrderKind
    conid: int
    symbol: str
    side: Literal["BUY", "SELL"]
    quantity: float
    order_type: str
    limit_price: float | None = None
    limit_offset: float | None = None
    stop_price: float | None = None
    trail: TwsTrailSpec | None = None
    good_till_date: str | None = None
    target_price: float | None = None
    lots: list[TwsScaleOutLotDraft] = []
    condition_price: float | None = None
    condition_is_above: bool | None = None

class TwsOrderLegPreview(BaseModel):
    role: str
    side: Literal["BUY", "SELL"]
    quantity: float
    order_type: str
    limit_price: float | None = None
    limit_offset: float | None = None
    stop_price: float | None = None
    trail: TwsTrailSpec | None = None
    tif: str = "DAY"
    good_till_date: str | None = None
    parent_ref: str | None = None
    oca_group: str | None = None
    transmit: bool = False

class TwsOrderPackagePreview(BaseModel):
    package_id: str
    kind: TwsAdvancedOrderKind
    conid: int
    symbol: str
    warnings: list[str] = []
    legs: list[TwsOrderLegPreview]
```

Service and adapter signatures:

```python
def preview_order_package(req: TwsOrderPackageRequest) -> TwsOrderPackagePreview:
    """Validate a package request and return the exact plain-data order graph."""

async def place_order_package(
    preview: TwsOrderPackagePreview,
    *,
    mode: str,
    live_policy: object | None = None,
    advanced_override: list[str] | None = None,
) -> TwsOrderPackageSubmission:
    """Submit a previously previewed package after paper/live policy checks."""
```

---

### Task 0: Mark Mission 2 In Progress

**Files:**
- Modify: `PROJECT_PLAN.md`

**Interfaces:**
- No runtime interface.

- [ ] Update the TWS follow-up missions line to say Mission 2 advanced order types is in progress on `feature/tws-advanced-order-types`.
- [ ] Run:

```bash
git diff --check
```

- [ ] Commit:

```bash
git add PROJECT_PLAN.md
git commit -m "docs: mark tws advanced orders in progress"
```

### Task 1: Preview And Validate Scale-Out Packages

**Files:**
- Modify: `backend/models/tws_execution_assistant.py`
- Create: `backend/services/tws_order_packages.py`
- Modify: `backend/routers/execution_assistant.py`
- Test: `backend/tests/test_execution_assistant_advanced_orders.py`

**Interfaces:**
- Produces `TwsOrderPackageRequest`, `TwsOrderPackagePreview`, and `preview_order_package(req)`.
- Produces `POST /execution-assistant/order-packages/preview`.

- [ ] Add the package models listed in the Interfaces section.
- [ ] Implement `preview_order_package(req)` for `kind="scale_out_ladder"` only.
- [ ] Validation rules:
  - `side` must be `BUY`.
  - `quantity` must be positive.
  - `order_type` must be `MKT` or `LMT`.
  - `LMT` entry requires positive `limit_price`.
  - lot quantities must be positive and sum exactly to entry quantity.
  - each lot requires positive `target_price`.
  - each lot requires exactly one stop style: positive `stop_price` or `trail`.
  - percent trail must be greater than `0` and less than `100`.
- [ ] Preview output for each lot must include target sell, stop/trailing sell, and `MOC` fallback sell with one generated `oca_group`.
- [ ] Add one public-boundary test: invalid lot quantities return `422` and no broker call is available from this preview-only route.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py -q
```

- [ ] Commit:

```bash
git add backend/models/tws_execution_assistant.py backend/services/tws_order_packages.py backend/routers/execution_assistant.py backend/tests/test_execution_assistant_advanced_orders.py
git commit -m "feat: preview tws scale-out packages"
```

### Task 2: Submit Scale-Out Packages

**Files:**
- Modify: `backend/models/tws_execution_assistant.py`
- Modify: `backend/routers/execution_assistant.py`
- Modify: `backend/services/tws_broker_adapter.py`
- Test: `backend/tests/test_execution_assistant_advanced_orders.py`

**Interfaces:**
- Consumes `TwsOrderPackagePreview`.
- Produces `TwsOrderPackageSubmission`.
- Produces `POST /execution-assistant/order-packages/place-paper` and `/place-live`.

- [ ] Add `TwsOrderPackageSubmission` with `package_id`, `status`, `order_ids`, and submitted leg summaries.
- [ ] Add router endpoints:
  - `POST /execution-assistant/order-packages/place-paper`
  - `POST /execution-assistant/order-packages/place-live`
- [ ] In the live endpoint, call `policy.assert_live_allowed(account_id=adapter.connected_account_id(), host=adapter.connected_host(), port=adapter.connected_port(), is_connected=adapter.is_connected(), is_paper_port=adapter.is_paper_port())` before adapter submit.
- [ ] In `TwsBrokerAdapter.place_order_package`, re-run `_ensure_order_mutation_allowed(mode=mode, live_policy=live_policy)` before building orders.
- [ ] Build a stock `Contract(conId=req.conid, symbol=req.symbol, secType="STK", exchange="SMART", currency="USD")`.
- [ ] Generate parent/child order IDs with `self._ib.client.getReqId()`.
- [ ] Set `parentId` on all exit legs and set per-lot `ocaGroup`/`ocaType=1`.
- [ ] Set `transmit=False` on every order except the final child.
- [ ] Add `orderRef="ORBIT:TWS:<package_id>:<role>"` to every leg.
- [ ] Preserve advanced reject handling and unknown-outcome handling from `place_order`.
- [ ] Add one public-boundary test: live place without armed policy returns `403` and adapter submit is not called.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py tests/test_execution_assistant_live_policy.py -q
```

- [ ] Commit:

```bash
git add backend/models/tws_execution_assistant.py backend/routers/execution_assistant.py backend/services/tws_broker_adapter.py backend/tests/test_execution_assistant_advanced_orders.py
git commit -m "feat: submit tws scale-out packages"
```

### Task 3: Reconcile Package Orders

**Files:**
- Modify: `backend/models/tws_execution_assistant.py`
- Modify: `backend/services/tws_broker_adapter.py`
- Modify: `src/modules/tws-execution-assistant/api.ts`

**Interfaces:**
- Extends `OrderSnapshot` with `parent_id`, `oca_group`, and `order_ref`.

- [ ] Add nullable fields to backend `OrderSnapshot`: `parent_id`, `oca_group`, `order_ref`.
- [ ] Populate those fields from `trade.order.parentId`, `trade.order.ocaGroup`, and `trade.order.orderRef`.
- [ ] Add matching optional fields to frontend `OrderSnapshot`.
- [ ] Do not create a persistent package store.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_reconciliation.py -q
npm run typecheck
```

- [ ] Commit:

```bash
git add backend/models/tws_execution_assistant.py backend/services/tws_broker_adapter.py src/modules/tws-execution-assistant/api.ts
git commit -m "feat: expose tws package reconciliation fields"
```

### Task 4: Add Bracket Packages

**Files:**
- Modify: `backend/services/tws_order_packages.py`
- Modify: `backend/services/tws_broker_adapter.py`
- Test: `backend/tests/test_execution_assistant_advanced_orders.py`

**Interfaces:**
- Extends `kind="bracket"` in `TwsOrderPackageRequest`.

- [ ] Validate bracket requests:
  - quantity positive.
  - side `BUY` or `SELL`.
  - entry `MKT` or `LMT`; `LMT` requires `limit_price`.
  - positive `target_price`.
  - exactly one stop style: `stop_price` or `trail`.
- [ ] Preview parent, profit-taker, and stop/trailing child.
- [ ] Build broker orders using the same parent/child/transmit pattern as `IB.bracketOrder`; use explicit construction when the stop is trailing.
- [ ] Add one focused test proving bracket preview has parent, profit, stop, and final `transmit=True`.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py -q
```

- [ ] Commit:

```bash
git add backend/services/tws_order_packages.py backend/services/tws_broker_adapter.py backend/tests/test_execution_assistant_advanced_orders.py
git commit -m "feat: add tws bracket packages"
```

### Task 5: Add Trailing, Good-Till-Date, Market-On-Close, And Limit-On-Close

**Files:**
- Modify: `backend/services/tws_order_packages.py`
- Modify: `backend/services/tws_broker_adapter.py`
- Test: `backend/tests/test_execution_assistant_advanced_orders.py`

**Interfaces:**
- Extends package kinds: `trailing_stop`, `gtd`, `moc`, `loc`.

- [ ] Add trailing validation:
  - fixed amount trail requires positive value.
  - percent trail requires value greater than `0` and less than `100`.
  - `TRAILLMT` requires positive `limit_offset`.
- [ ] Map fixed trail to `Order.auxPrice`, percent trail to `Order.trailingPercent`, and trailing-stop-limit offset to `Order.lmtPriceOffset`.
- [ ] Add good-till-date validation: `good_till_date` is required when `kind="gtd"`.
- [ ] Add close order validation: `MOC` has no limit price; `LOC` requires positive `limit_price`.
- [ ] Add one focused test covering percent trailing preview and one focused test covering `LOC` rejects missing limit price.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py -q
```

- [ ] Commit:

```bash
git add backend/services/tws_order_packages.py backend/services/tws_broker_adapter.py backend/tests/test_execution_assistant_advanced_orders.py
git commit -m "feat: add tws trailing and close order packages"
```

### Task 6: Add One Price Condition Slice

**Files:**
- Modify: `backend/services/tws_order_packages.py`
- Modify: `backend/services/tws_broker_adapter.py`
- Test: `backend/tests/test_execution_assistant_advanced_orders.py`

**Interfaces:**
- Extends `kind="price_condition"` with `condition_price` and `condition_is_above`.

- [ ] Validate a single price condition only: positive `condition_price`, boolean `condition_is_above`, and stock `conid`.
- [ ] In the adapter, create `PriceCondition(price=req.condition_price, conId=req.conid, exch="SMART", isMore=req.condition_is_above)`.
- [ ] Attach it to the one broker order in `order.conditions`.
- [ ] Keep broad condition builders out of scope.
- [ ] Add one focused preview test for price condition fields.
- [ ] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py -q
```

- [ ] Commit:

```bash
git add backend/services/tws_order_packages.py backend/services/tws_broker_adapter.py backend/tests/test_execution_assistant_advanced_orders.py
git commit -m "feat: add tws price condition package"
```

### Task 7: Cockpit Package Review UI

**Files:**
- Modify: `src/modules/tws-execution-assistant/api.ts`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- Consumes backend package request, preview, and submission contracts.

- [ ] Add TypeScript package request/preview/submission types matching backend names.
- [ ] Add `twsApi.previewOrderPackage`, `placePaperOrderPackage`, and `placeLiveOrderPackage`.
- [ ] Add a compact advanced-order mode in the cockpit for:
  - scale-out ladder.
  - bracket.
  - trailing stop fixed/percent.
  - good-till-date.
  - market-on-close.
  - limit-on-close.
  - price condition.
- [ ] Show preview legs with role, side, quantity, order type, prices, trail, parent, OCA group, and transmit flag.
- [ ] Route submit to paper or live package endpoint using the existing live-session state.
- [ ] Run:

```bash
npm run typecheck
```

- [ ] Commit:

```bash
git add src/modules/tws-execution-assistant/api.ts src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: add tws advanced order cockpit flow"
```

### Task 8: Roadmap, Smoke Notes, And Merge-Gate Verification

**Files:**
- Modify: `PROJECT_PLAN.md`

**Interfaces:**
- No new runtime interface.

- [ ] Update `PROJECT_PLAN.md` to say Mission 2 is code-complete and awaiting review/smoke.
- [ ] Run focused backend and frontend checks:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py tests/test_execution_assistant_live_policy.py tests/test_execution_assistant_reconciliation.py -q
npm run typecheck
git diff --check
```

- [ ] Manual smoke with human present:
  - paper preview scale-out.
  - paper submit a tiny scale-out package if acceptable.
  - paper preview bracket and percent trailing stop.
  - live preview only unless the human explicitly approves a live order mutation.
- [ ] Commit:

```bash
git add PROJECT_PLAN.md
git commit -m "docs: update tws advanced order status"
```

---

## Recommended Batches

- Batch 1: Tasks 0 and 1. Review the contract before broker mutation exists.
- Batch 2: Tasks 2 and 3. Review immediately because this introduces grouped broker mutation and reconciliation fields.
- Batch 3: Tasks 4 and 5. Brackets, trailing, good-till-date, market-on-close, and limit-on-close share the same order builder.
- Batch 4: Task 6 only. Conditions use a separate TWS API surface.
- Batch 5: Tasks 7 and 8. UI and final docs after backend contracts settle.

Run code review after every batch. Run human manual smoke only after Batch 5, unless Batch 2 needs a focused paper-only broker smoke before continuing.
