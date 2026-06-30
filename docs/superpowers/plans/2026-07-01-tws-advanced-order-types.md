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

- [x] Update the TWS follow-up missions line to say Mission 2 advanced order types is in progress on `feature/tws-advanced-order-types`.
- [x] Run:

```bash
git diff --check
```

- [x] Commit:

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

- [x] Add the package models listed in the Interfaces section.
- [x] Implement `preview_order_package(req)` for `kind="scale_out_ladder"` only.
- [x] Validation rules:
  - `side` must be `BUY`.
  - `quantity` must be positive.
  - `order_type` must be `MKT` or `LMT`.
  - `LMT` entry requires positive `limit_price`.
  - lot quantities must be positive and sum exactly to entry quantity.
  - each lot requires positive `target_price`.
  - each lot requires exactly one stop style: positive `stop_price` or `trail`.
  - percent trail must be greater than `0` and less than `100`.
- [x] Preview output for each lot must include target sell, stop/trailing sell, and `MOC` fallback sell with one generated `oca_group`. **Superseded 2026-07-01:** each lot also gets its own parent entry leg — see Task 2.5.
- [x] Add one public-boundary test: invalid lot quantities return `422` and no broker call is available from this preview-only route.
- [x] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py -q
```

- [x] Commit:

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

- [x] Add `TwsOrderPackageSubmission` with `package_id`, `status`, `order_ids`, and submitted leg summaries.
- [x] Add router endpoints:
  - `POST /execution-assistant/order-packages/place-paper`
  - `POST /execution-assistant/order-packages/place-live`
- [x] In the live endpoint, call `policy.assert_live_allowed(account_id=adapter.connected_account_id(), host=adapter.connected_host(), port=adapter.connected_port(), is_connected=adapter.is_connected(), is_paper_port=adapter.is_paper_port())` before adapter submit.
- [x] In `TwsBrokerAdapter.place_order_package`, re-run `_ensure_order_mutation_allowed(mode=mode, live_policy=live_policy)` before building orders.
- [x] Build a stock `Contract(conId=req.conid, symbol=req.symbol, secType="STK", exchange="SMART", currency="USD")`.
- [x] Generate parent/child order IDs with `self._ib.client.getReqId()`.
- [x] Set `parentId` on all exit legs and set per-lot `ocaGroup`/`ocaType=1`. **Superseded 2026-07-01:** a single shared parent let TWS merge all lots into one OCA cohort — see Task 2.5.
- [x] Set `transmit=False` on every order except the final child.
- [x] Add `orderRef="ORBIT:TWS:<package_id>:<role>"` to every leg.
- [x] Preserve advanced reject handling and unknown-outcome handling from `place_order`.
- [x] Add one public-boundary test: live place without armed policy returns `403` and adapter submit is not called.
- [x] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py tests/test_execution_assistant_live_policy.py -q
```

- [x] Commit:

```bash
git add backend/models/tws_execution_assistant.py backend/routers/execution_assistant.py backend/services/tws_broker_adapter.py backend/tests/test_execution_assistant_advanced_orders.py
git commit -m "feat: submit tws scale-out packages"
```

Also committed (same batch, after code review): `fix: revalidate tws order packages at submit time and scope OCA groups per package` — `/place-paper` and `/place-live` now accept `TwsOrderPackageRequest` and re-derive the trusted preview server-side via `preview_order_package(req)` instead of trusting a client-supplied `TwsOrderPackagePreview`.

### Task 2.5: Repair Scale-Out Parent Isolation And Add Minimal Cockpit Path

**Why:** manual paper-account testing (2026-07-01) proved Task 2's shared-parent
design unsafe — see "Per-Lot Parent Isolation" in the design doc. TWS auto-links
every order sharing one `parentId` into one OCA cohort regardless of any custom
`ocaGroup` string, so the original single combined entry caused all three lots'
exits to merge into one TWS-assigned group with every exit's quantity normalized
to the full parent size.

**Files:**
- Modify: `backend/services/tws_order_packages.py`
- Modify: `backend/services/tws_broker_adapter.py`
- Modify: `backend/tests/test_execution_assistant_advanced_orders.py`
- Modify: `src/modules/tws-execution-assistant/api.ts`
- Create: `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`
- Modify: this plan and the design doc.

**Interfaces:** unchanged (`TwsOrderPackageRequest` → `preview_order_package` →
`TwsOrderPackagePreview` → `place_order_package`); only the internal leg graph
changes shape.

- [x] `_scale_out_ladder_legs` builds one parent entry leg per lot (role
      `lot{i}_entry`, sized to that lot's own quantity, `parent_ref=None`),
      with that lot's target/stop-or-trail/MOC-fallback referencing only
      `lot{i}_entry` and sharing only that lot's `oca_group`.
- [x] `TwsBrokerAdapter.place_order_package` resolves each leg's `parentId` by
      role (`order_id_by_role[leg.parent_ref]`) instead of a single shared root,
      so multiple independent parents in one package resolve correctly.
- [x] Add one public-boundary preview test proving one entry parent per lot,
      each sized to its own lot, with exits referencing only their own lot.
- [x] Add one adapter-level test (fake IB client) proving the actual broker
      order graph has no shared `parentId` or `oca_group` across lots.
- [x] Add minimal cockpit path: `ScaleOutLadderPanel` (symbol/conid/entry +
      per-lot quantity/target/stop-or-trail inputs, preview table showing
      role/side/qty/type/price/parent/OCA/transmit per leg, paper/live submit
      via existing `twsApi`/`isLiveSession` patterns). Mounted in
      `TwsExecutionAssistantModule.tsx` below Positions/Open Orders.
- [x] Run:

```bash
cd backend && uv run python -m pytest tests/test_execution_assistant_advanced_orders.py tests/test_execution_assistant_live_policy.py tests/test_execution_assistant_reconciliation.py -q
npm run typecheck
git diff --check
```

- [x] Commit:

```bash
git add backend/services/tws_order_packages.py backend/services/tws_broker_adapter.py backend/tests/test_execution_assistant_advanced_orders.py
git commit -m "fix: isolate tws scale-out lots by parent order"
git add src/modules/tws-execution-assistant/api.ts src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: add scale-out cockpit package flow"
git add docs/superpowers/specs/2026-06-30-tws-advanced-order-types-design.md docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md
git commit -m "docs: update tws advanced order plan for vertical slices"
```

**Resolved 2026-07-01:** manual paper-account smoke against the cockpit UI confirmed TWS shows isolated per-lot parents and distinct OCA groups end to end.

That smoke pass also surfaced three real UX bugs the unit tests couldn't catch, fixed in the same window:
- `fix: scale-out panel overflow, modify routing, and spacing parity` — the Execution Plan/Chart grid used `min-h-[405px]` (a floor, not a ceiling), so a tall Scale-Out form grew the panel into the Positions/Open Orders section below instead of scrolling internally; the Execution Plan ternary checked `planMode === "scale_out"` before `editingOrder`/`advancedReject`, so clicking "Modify" on any open order silently did nothing while Scale-Out was selected; Scale-Out's inputs/gaps were denser than Standard's.
- `fix: stop relying on percentage height through grid stretch for panel sizing` — `h-full` resolving against a CSS Grid row sized via stretch alignment is inconsistent across engines (including WebKit/Tauri); switched the panel and chart aside to an explicit `h-[480px]` plus `overflow-hidden` as a hard backstop.

Separately, user feedback ("I don't like the UI... make it feel less robotic") led to a follow-up UX pass, brainstormed and spec'd properly rather than patched ad hoc: see `docs/superpowers/specs/2026-07-01-scale-out-cockpit-ux-design.md` (toggle mechanism, copy voice, tooltip scope, lot-card layout — all chosen via the visual-companion brainstorming flow and user approval). Implemented in `feat: merge scale-out ladder into Execution Plan panel`. **This design doc, not Task 7 below, is now the canonical reference for how cockpit UI for any future order kind should look and feel** — see the note on Task 7.

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

**Superseded 2026-07-01:** scale-out's cockpit slice already shipped in Task 2.5,
via a Standard/Scale-Out toggle merged into the Execution Plan panel rather than
a free-standing "advanced-order mode." That pattern — and the full rationale
for the toggle mechanism, copy voice, tooltip scope, and lot-card layout — is
documented in `docs/superpowers/specs/2026-07-01-scale-out-cockpit-ux-design.md`.
**Extend that pattern for the remaining kinds; do not design a separate UI
paradigm per kind.** Concretely: the toggle likely grows from 2 options to N
(one per implemented kind, or a kind dropdown once N gets large), each kind
reuses the same intro-blurb / tooltip / live-readout / preview-table
conventions already built for scale-out. Brainstorm any new toggle-shape
decision the same way scale-out's was (visual companion, get approval) rather
than guessing — this is still a user-facing design question, not a pure
implementation one.

- [ ] Add TypeScript package request/preview/submission types for the new kinds (`TwsOrderPackageRequest` etc. already exist from Task 2.5 — extend, don't duplicate).
- [ ] Add `twsApi` calls for any new endpoints the new kinds need (none expected — `previewOrderPackage`/`placePaperOrderPackage`/`placeLiveOrderPackage` already exist and are kind-agnostic).
- [ ] Extend the existing toggle/builder pattern to cover:
  - bracket.
  - trailing stop fixed/percent.
  - good-till-date.
  - market-on-close.
  - limit-on-close.
  - price condition.
- [ ] Preview legs already show role, side, quantity, order type, prices, trail, parent, OCA group, and transmit flag (built in Task 2.5) — confirm this still reads correctly for each new kind's leg shape, don't rebuild it.
- [ ] Submit already routes to paper/live package endpoints using existing live-session state (built in Task 2.5) — no new routing needed unless a kind's UX requires it.
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

- Batch 1: Tasks 0 and 1. Review the contract before broker mutation exists. DONE.
- Batch 2: Tasks 2 and 3 (reconciliation fields only; package reconciliation
  warnings still open). DONE. Code review on this batch found a client-trusted
  preview at submit time and colliding OCA names; both fixed same batch.
- Batch 2.5 (unplanned, vertical-slice repair): Task 2.5. A focused paper-account
  smoke test on Batch 2's output surfaced the shared-parent OCA/quantity bug
  before Batch 3 could build brackets/trailing on top of the same broken
  pattern. Repaired per-lot parent isolation and pulled the minimal scale-out
  cockpit UI forward from Batch 5 so the repair is reviewable end-to-end
  against a real paper account, not just unit tests. DONE pending manual smoke.
- Batch 3: Tasks 4 and 5. Brackets, trailing, good-till-date, market-on-close, and limit-on-close share the same order builder — they inherit the per-lot/per-group parent-isolation pattern from Task 2.5 (bracket has exactly one group already, so it is unaffected by the multi-group case).
- Batch 4: Task 6 only. Conditions use a separate TWS API surface.
- Batch 5: Task 8 only (remaining cockpit UI for bracket/trailing/GTD/MOC/LOC/condition) and final docs after backend contracts settle. Scale-out's own cockpit slice shipped early in Batch 2.5.

Run code review after every batch. A focused paper-only broker smoke is
valuable after any batch that changes broker order construction (Batch 2 and
2.5 both needed one) — do not wait for Batch 5 to do the first real-account
check of a new construction pattern.
