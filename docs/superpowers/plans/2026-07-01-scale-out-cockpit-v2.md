# Scale-Out Cockpit V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the scale-out cockpit so users resolve symbols by search, read compact scenario math, and see linked scale-out orders as packages instead of unrelated rows.

**Architecture:** Keep this slice frontend/read-only except for the already-existing package preview/place endpoints. Instrument search reuses `twsApi.searchInstruments`; scenario math is a pure TypeScript helper; package grouping is derived from reconciliation `order_ref` values already exposed by Task 3.

**Tech Stack:** React 19, TypeScript, TanStack Query, Vitest, existing TWS Execution Assistant API contracts.

## Global Constraints

- No new broker mutation behavior in this plan.
- No database package persistence.
- No direct `fetch`; use `twsApi` only.
- Scale-out package legs must not show per-leg `Modify` or per-leg `Cancel`.
- Package replace is read-only in this plan; actual replace mutation needs a separate broker-safety plan.
- Use existing TWS cockpit CSS variables and dark/light mode support.
- Follow `docs/testing.md`: add only the focused tests that protect money math and package grouping.

---

## File Map

- Modify `docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md`: insert Scale-Out Cockpit V2 before brackets.
- Modify `PROJECT_PLAN.md`: note that Mission 2 is doing the Scale-Out Cockpit V2 interlude before brackets.
- Modify `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`: symbol search, cleaner builder, calculator mount.
- Create `src/modules/tws-execution-assistant/ScaleOutScenarioCalculator.tsx`: compact calculator UI.
- Create `src/modules/tws-execution-assistant/scaleOutScenario.ts`: pure scenario math.
- Create `src/modules/tws-execution-assistant/scaleOutScenario.test.ts`: focused scenario math test.
- Create `src/modules/tws-execution-assistant/scaleOutPackages.ts`: parse and group package orders from reconciliation.
- Create `src/modules/tws-execution-assistant/scaleOutPackages.test.ts`: focused package grouping test.
- Create `src/modules/tws-execution-assistant/ScaleOutPackageManagerPanel.tsx`: read-only package management view.
- Modify `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`: pass chart-sync callback, render grouped Open Orders, render read-only manage view.

## Interfaces

```ts
// src/modules/tws-execution-assistant/scaleOutScenario.ts
export type ScaleOutScenarioExitMode = "stops" | "close";

export interface ScaleOutScenarioLot {
  quantity: number;
  targetPrice: number;
  stopPrice: number | null;
  trailAmount: number | null;
}

export interface ScaleOutScenarioResult {
  bestCase: number | null;
  worstCase: number | null;
  selected: number | null;
  targetGain: number;
  remainingExit: number | null;
}

export function calculateScaleOutScenario(input: {
  entryPrice: number | null;
  lots: ScaleOutScenarioLot[];
  targetsHit: number;
  exitMode: ScaleOutScenarioExitMode;
  closePrice: number | null;
}): ScaleOutScenarioResult;
```

```ts
// src/modules/tws-execution-assistant/scaleOutPackages.ts
export interface ParsedScaleOutRole {
  packageId: string;
  lotIndex: number;
  roleType: "entry" | "target" | "stop" | "trail" | "moc_fallback";
}

export interface ScaleOutOrderPackage {
  packageId: string;
  conid: number;
  symbol: string;
  orders: OrderSnapshot[];
  warnings: TwsPackageWarning[];
  lots: Array<{
    lotIndex: number;
    entry: OrderSnapshot | null;
    exits: OrderSnapshot[];
  }>;
}

export function parseScaleOutOrderRef(orderRef: string | null): ParsedScaleOutRole | null;
export function groupScaleOutOrders(recon: ReconciliationSnapshot): {
  packages: ScaleOutOrderPackage[];
  standaloneOrders: OrderSnapshot[];
};
```

---

### Task 0: Record The V2 Interlude Before Brackets

**Files:**
- Modify: `docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md`
- Modify: `PROJECT_PLAN.md`

**Interfaces:**
- No runtime interface.

- [ ] Add a checked/dated note after Task 3 in `docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md` that Scale-Out Cockpit V2 is the next approved slice before Task 4 brackets.
- [ ] Update `PROJECT_PLAN.md` under the TWS follow-up missions bullet to mention the Scale-Out Cockpit V2 interlude on `feature/tws-advanced-order-types`.
- [ ] Run:

```bash
git diff --check
```

- [ ] Commit:

```bash
git add PROJECT_PLAN.md docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md
git commit -m "docs: plan scale-out cockpit v2 before brackets"
```

### Task 1: Resolve Scale-Out Symbols And Clean Up The Builder

**Files:**
- Modify: `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- Consumes: `twsApi.searchInstruments(symbol)` and `InstrumentResult`.
- Produces: `ScaleOutLadderPanel` props:

```ts
interface ScaleOutLadderPanelProps {
  canDraft: boolean;
  isLiveSession: boolean;
  connected: boolean;
  onInstrumentResolved: (instrument: InstrumentResult) => void;
}
```

- [ ] Replace the editable `ConID` input with symbol search inside `ScaleOutLadderPanel`.
- [ ] Use the same stock filter as Standard mode:

```ts
const stk = results.filter(
  (r) => r.sec_type === "STK" && r.exchange === "SMART" && r.currency === "USD",
);
```

- [ ] When exactly one SMART USD stock result exists, set local `symbol` and `conid`, call `onInstrumentResolved(stk[0])`, and clear search results.
- [ ] In `TwsExecutionAssistantModule.tsx`, pass:

```tsx
<ScaleOutLadderPanel
  canDraft={canDraft}
  isLiveSession={isLiveSession}
  connected={connected}
  onInstrumentResolved={(instrument) => {
    setPlanForm((f) => ({ ...f, symbol: instrument.symbol, conid: instrument.conid }));
    setSelectedExchange(instrument.primary_exchange);
  }}
/>
```

- [ ] Restyle lot rows as compact trade stages: reduce white-box weight, keep labels short, use `font-data`/tabular numbers on all money and quantity values, and keep the total-share bar.
- [ ] Run:

```bash
npm run typecheck
git diff --check
```

- [ ] Manual smoke:
  - type `INTC` in Scale-Out.
  - search resolves `conid`.
  - chart/quote panel updates to the resolved instrument.
  - preview still builds the same scale-out request.

- [ ] Commit:

```bash
git add src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: resolve scale-out instruments by symbol search"
```

### Task 2: Add The Compact Scenario Calculator

**Files:**
- Create: `src/modules/tws-execution-assistant/scaleOutScenario.ts`
- Create: `src/modules/tws-execution-assistant/scaleOutScenario.test.ts`
- Create: `src/modules/tws-execution-assistant/ScaleOutScenarioCalculator.tsx`
- Modify: `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`

**Interfaces:**
- Produces: `calculateScaleOutScenario(input)` from the Interfaces section.
- Consumes: Scale-Out builder state (`limitPrice`, `lots`) converted to numbers.

- [ ] Add `scaleOutScenario.ts` with the exact exported types and function from the Interfaces section.
- [ ] Implement formulas:
  - `bestCase = sum(quantity * (targetPrice - entryPrice))` when all lots have valid targets.
  - `worstCase = sum(quantity * (stopOrEstimatedTrail - entryPrice))`, where fixed stops use `stopPrice` and fixed trails estimate `entryPrice - trailAmount`.
  - `selected` uses target profits for the first `targetsHit` lots and either stop/trail estimates or `closePrice` for the remaining lots.
  - return `null` for a headline number when required inputs are incomplete.
- [ ] Add this focused test:

```ts
import { describe, expect, it } from "vitest";
import { calculateScaleOutScenario } from "./scaleOutScenario";

describe("calculateScaleOutScenario", () => {
  it("calculates best, worst, and partial target outcomes", () => {
    const lots = [
      { quantity: 5, targetPrice: 125, stopPrice: 115, trailAmount: null },
      { quantity: 5, targetPrice: 130, stopPrice: 115, trailAmount: null },
      { quantity: 10, targetPrice: 135, stopPrice: 112, trailAmount: null },
    ];

    expect(calculateScaleOutScenario({
      entryPrice: 120,
      lots,
      targetsHit: 1,
      exitMode: "stops",
      closePrice: null,
    })).toMatchObject({ bestCase: 225, worstCase: -130, selected: -80 });

    expect(calculateScaleOutScenario({
      entryPrice: 120,
      lots,
      targetsHit: 2,
      exitMode: "stops",
      closePrice: null,
    }).selected).toBe(-5);
  });
});
```

- [ ] Add `ScaleOutScenarioCalculator.tsx` with three headline numbers (`Best case`, `Worst stop case`, `Selected`), a segmented targets-hit control (`0`, `1`, `2`, `All`), an exit-mode control (`Stops`, `End of day close`), one close-price input, and one short breakdown line.
- [ ] Mount the calculator above `Preview ladder`.
- [ ] Run:

```bash
npm run test -- src/modules/tws-execution-assistant/scaleOutScenario.test.ts
npm run typecheck
git diff --check
```

- [ ] Manual smoke:
  - enter the 20-share INTC story.
  - confirm headline values match `+$225`, `-$130`, `-$80`, and `-$5` for the matching selected scenarios.
  - switch to end-of-day close and confirm only the selected scenario changes from the assumed close price.

- [ ] Commit:

```bash
git add src/modules/tws-execution-assistant/scaleOutScenario.ts src/modules/tws-execution-assistant/scaleOutScenario.test.ts src/modules/tws-execution-assistant/ScaleOutScenarioCalculator.tsx src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx
git commit -m "feat: add scale-out scenario calculator"
```

### Task 3: Group Open Orders Into Read-Only Scale-Out Packages

**Files:**
- Create: `src/modules/tws-execution-assistant/scaleOutPackages.ts`
- Create: `src/modules/tws-execution-assistant/scaleOutPackages.test.ts`
- Create: `src/modules/tws-execution-assistant/ScaleOutPackageManagerPanel.tsx`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- Produces: `parseScaleOutOrderRef(orderRef)` and `groupScaleOutOrders(recon)` from the Interfaces section.
- Consumes: `ReconciliationSnapshot.open_orders`, `ReconciliationSnapshot.package_warnings`, `OrderSnapshot.order_ref`.

- [ ] Add `scaleOutPackages.ts` with parser regex:

```ts
const SCALE_OUT_REF = /^ORBIT:TWS:([^:]+):lot(\d+)_(entry|target|stop|trail|moc_fallback)$/;
```

- [ ] Group matching package orders by package id; return unmatched orders as `standaloneOrders`.
- [ ] Attach warnings where `warning.package_id === package.packageId`.
- [ ] Sort lots by `lotIndex`; sort each lot exits by role order `target`, `stop`, `trail`, `moc_fallback`.
- [ ] Add this focused test:

```ts
import { describe, expect, it } from "vitest";
import { groupScaleOutOrders } from "./scaleOutPackages";
import type { ReconciliationSnapshot } from "./api";

describe("groupScaleOutOrders", () => {
  it("groups scale-out package legs and leaves normal orders standalone", () => {
    const recon: ReconciliationSnapshot = {
      position_count: 0,
      open_order_count: 3,
      unmanaged_order_count: 0,
      positions: [],
      package_warnings: [],
      open_orders: [
        order(1, "ORBIT:TWS:pkg1:lot0_entry"),
        order(2, "ORBIT:TWS:pkg1:lot0_target"),
        order(3, null),
      ],
    };

    const grouped = groupScaleOutOrders(recon);
    expect(grouped.packages).toHaveLength(1);
    expect(grouped.packages[0].packageId).toBe("pkg1");
    expect(grouped.packages[0].lots[0].entry?.order_id).toBe(1);
    expect(grouped.packages[0].lots[0].exits.map((o) => o.order_id)).toEqual([2]);
    expect(grouped.standaloneOrders.map((o) => o.order_id)).toEqual([3]);
  });
});

function order(order_id: number, order_ref: string | null) {
  return {
    order_id,
    conid: 270639,
    symbol: "INTC",
    side: order_id === 1 ? "BUY" : "SELL",
    quantity: 5,
    order_type: "LMT",
    lmt_price: 125,
    stop_price: null,
    status: "Submitted",
    is_unmanaged: false,
    parent_id: null,
    oca_group: null,
    order_ref,
  };
}
```

- [ ] Render grouped packages above standalone rows in Open Orders.
- [ ] Package rows show one package header with `Scale-Out`, symbol, short package id, warning count, and a `Manage package` button.
- [ ] Nested rows show lot number, role, side, quantity, type, price, status, parent id, and OCA group.
- [ ] Do not render `Cancel` or `Modify` on scale-out package legs.
- [ ] Add `managedScaleOutPackage` state in `TwsExecutionAssistantModule.tsx`; clicking `Manage package` clears `editingOrder` and `advancedReject`, then shows `ScaleOutPackageManagerPanel` in the Execution Plan panel.
- [ ] `ScaleOutPackageManagerPanel` is read-only: header, current lots, warnings, and a clear note that package replace needs a separate review flow.
- [ ] Run:

```bash
npm run test -- src/modules/tws-execution-assistant/scaleOutPackages.test.ts
npm run typecheck
git diff --check
```

- [ ] Manual smoke:
  - submit or load a paper scale-out package.
  - Open Orders shows one grouped package with nested lots.
  - normal orders still show `Cancel` and `Modify`.
  - scale-out package legs do not show per-leg mutation buttons.
  - `Manage package` opens a read-only package view in Execution Plan.

- [ ] Commit:

```bash
git add src/modules/tws-execution-assistant/scaleOutPackages.ts src/modules/tws-execution-assistant/scaleOutPackages.test.ts src/modules/tws-execution-assistant/ScaleOutPackageManagerPanel.tsx src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: group scale-out orders by package"
```

### Task 4: Final Verification Notes

**Files:**
- Modify: `docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md`

**Interfaces:**
- No runtime interface.

- [ ] Mark the Scale-Out Cockpit V2 interlude complete in `docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md` and record the manual smoke result.
- [ ] Run:

```bash
npm run test -- src/modules/tws-execution-assistant/scaleOutScenario.test.ts src/modules/tws-execution-assistant/scaleOutPackages.test.ts
npm run typecheck
git diff --check
```

- [ ] Commit:

```bash
git add docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md
git commit -m "docs: mark scale-out cockpit v2 complete"
```
