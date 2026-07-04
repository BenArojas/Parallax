# TWS Execution Plan Flow Sheet Implementation Plan

> Status: SHIPPED to `dev`
> Archived: 2026-07-04

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rejected Execution Plan Anatomy UI with the approved compact Flow Sheet design across Standard, Scale-Out, Bracket, and Advanced modes.

**Architecture:** Keep this frontend-only. Remove the old `PlanAnatomyPanel` path, introduce shared Flow Sheet primitives for the common card/row/field grammar, wire each mode to those primitives, and upgrade existing scale-out scenario math to per-lot outcome assumptions.

**Tech Stack:** React 19, TypeScript, Tailwind v4 utility classes, existing Orbit CSS variables, existing TWS draft/preview APIs, Vitest for the existing scenario math unit test.

## Global Constraints

- Use the approved mockup: `docs/archive/assets/2026-07-04-execution-plan-flow-sheet-reset.html`.
- Mode accents: Standard cyan, Scale-Out purple, Bracket orange, Advanced blue.
- Do not duplicate connection status in the symbol row.
- Symbol search edits ticker text only; `conid` renders as read-only metadata.
- Keep guidance text-light: one sentence plus tiny status words.
- Scale-Out scenario math is preview-only and must not mutate lot fields or broker order payloads.
- No backend, API, broker, persistence, live-trading policy, or chart-line behavior changes.
- Verification commands: `npm run typecheck`, `git diff --check`, and `npx vitest run src/modules/tws-execution-assistant/scaleOutScenario.test.ts`.

---

## File Structure

- Delete `src/modules/tws-execution-assistant/PlanAnatomyPanel.tsx`
  - Remove the rejected anatomy UI and all imports.
- Create `src/modules/tws-execution-assistant/ExecutionPlanFlowSheet.tsx`
  - Own shared presentation primitives only: sheet, rows, compact fields,
    segmented controls, symbol search row, guidance/status row, summary footer.
- Modify `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`
  - Replace the current Standard ticket/anatomy surface with Flow Sheet
    primitives. Keep current draft/review behavior.
- Modify `src/modules/tws-execution-assistant/BracketBuilderPanel.tsx`
  - Replace the current bracket ticket/anatomy surface with Flow Sheet
    primitives. Keep `buildRequest()` and `previewMutation` unchanged.
- Modify `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`
  - Replace intro/anatomy/old form styling with Flow Sheet primitives and keep
    existing lot/package preview behavior.
- Modify `src/modules/tws-execution-assistant/AdvancedOrderPanel.tsx`
  - Replace long callouts/anatomy with Flow Sheet primitives while preserving
    existing subtype payloads.
- Modify `src/modules/tws-execution-assistant/scaleOutScenario.ts`
  - Support per-lot outcome assumptions: `"target" | "stop" | "fallback"`.
- Modify `src/modules/tws-execution-assistant/ScaleOutScenarioCalculator.tsx`
  - Render the compact scenario math strip and per-lot assumption controls.
- Modify `src/modules/tws-execution-assistant/scaleOutScenario.test.ts`
  - Update focused tests for per-lot assumptions.

## Task 1: Shared Flow Sheet Primitives

**Files:**
- Create: `src/modules/tws-execution-assistant/ExecutionPlanFlowSheet.tsx`
- Delete: `src/modules/tws-execution-assistant/PlanAnatomyPanel.tsx`
- Modify imports in:
  - `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`
  - `src/modules/tws-execution-assistant/BracketBuilderPanel.tsx`
  - `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`
  - `src/modules/tws-execution-assistant/AdvancedOrderPanel.tsx`

**Interfaces:**
- Produces shared UI primitives:

```ts
export type ExecutionPlanFlowMode = "standard" | "scale_out" | "bracket" | "advanced";
export type FlowStatusTone = "done" | "todo" | "active";

export interface FlowStatusItem {
  key: string;
  label: string;
  tone: FlowStatusTone;
  targetId?: string;
}
```

- [ ] Create `ExecutionPlanFlowSheet.tsx` with these exports:

```tsx
export function FlowSheet(props: { mode: ExecutionPlanFlowMode; children: React.ReactNode }): JSX.Element;
export function FlowRow(props: { children: React.ReactNode; className?: string; id?: string }): JSX.Element;
export function FlowField(props: { label: string; children: React.ReactNode }): JSX.Element;
export function FlowValueInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { prefix?: string; suffix?: string },
): JSX.Element;
export function FlowSegmented<T extends string>(props: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  getLabel?: (value: T) => string;
}): JSX.Element;
export function FlowGuidance(props: { children: React.ReactNode; status: FlowStatusItem[] }): JSX.Element;
export function FlowSummary(props: { notional: string; children: React.ReactNode }): JSX.Element;
```

- [ ] Implement styling with existing CSS variables only. Use a left accent rail,
  hairline separators, compact underlined inputs, tabular numbers, and `active:scale-[0.96]`
  on buttons.
- [ ] Remove every `PlanAnatomyPanel` import and usage. Delete
  `PlanAnatomyPanel.tsx`.
- [ ] Run `npm run typecheck` after all `PlanAnatomyPanel` imports are removed.
  Expected: pass for this task before moving on.

## Task 2: Standard Mode Tracer Slice

**Files:**
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

**Interfaces:**
- Consumes existing `planForm`, `canDraft`, `runSearch`, `searchResults`,
  `reviewMutation`, `standardDraftReason`.
- Produces the Standard Flow Sheet UI.

- [ ] Replace the current Standard "Order ticket" surface with `FlowSheet mode="standard"`.
- [ ] Keep symbol input editable and search by symbol only. Render `conid` as
  read-only metadata next to company/exchange/currency.
- [ ] Keep existing Standard field state and review behavior unchanged:
  `side`, `quantity`, `order_type`, `limit_price`, `stop_price`, and
  `reviewMutation.mutate(planForm)`.
- [ ] Render one guidance sentence:
  `Plan: Buy/Sell {quantity} {symbol} with {entry wording}. Review before sending.`
- [ ] Render inline status words: Symbol, Size, Entry, Exit, Review.
- [ ] Run `npm run typecheck` and browser-smoke Standard in dark and light mode.

## Task 3: Bracket And Advanced Flow Sheet Parity

**Files:**
- Modify: `src/modules/tws-execution-assistant/BracketBuilderPanel.tsx`
- Modify: `src/modules/tws-execution-assistant/AdvancedOrderPanel.tsx`

**Interfaces:**
- Bracket keeps existing `buildRequest(...)` and `previewMutation.mutate(req)`.
- Advanced keeps existing subtype-specific preview/place payloads.

- [ ] Replace Bracket's current ticket/anatomy surface with
  `FlowSheet mode="bracket"`.
- [ ] Render Bracket target/stop/trail fields as compact Flow Sheet rows.
- [ ] Render Bracket sentence:
  `Plan: Buy/Sell {quantity} {symbol}. If filled, attach {target} and {stop/trail}.`
- [ ] Replace Advanced long callouts/anatomy with `FlowSheet mode="advanced"`.
- [ ] Render Advanced subtype selector as compact segmented controls and keep
  subtype payload behavior unchanged.
- [ ] Render Advanced sentence:
  `Plan: Buy/Sell {quantity} {symbol} with an attached rule. Review shows the exact broker effect.`
- [ ] Run `npm run typecheck` and browser-smoke Bracket orange and Advanced blue.

## Task 4: Scale-Out Flow Sheet And Adjustable Scenario Math

**Files:**
- Modify: `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`
- Modify: `src/modules/tws-execution-assistant/ScaleOutScenarioCalculator.tsx`
- Modify: `src/modules/tws-execution-assistant/scaleOutScenario.ts`
- Modify: `src/modules/tws-execution-assistant/scaleOutScenario.test.ts`

**Interfaces:**
- Scale-Out keeps existing entry/lot state and package preview behavior.
- Scenario math consumes existing entry price and lot rows.
- Scenario assumptions are UI-only and do not write back to lot fields.

- [ ] Replace Scale-Out's current intro/anatomy/form surface with
  `FlowSheet mode="scale_out"`.
- [ ] Keep compact lot rows close to the mockup: lot id, quantity, target, stop,
  fallback.
- [ ] Update scenario types:

```ts
export type ScaleOutScenarioOutcome = "target" | "stop" | "fallback";

export interface ScaleOutScenarioAssumption {
  lotIndex: number;
  outcome: ScaleOutScenarioOutcome;
  fallbackPrice: number | null;
}
```

- [ ] Update `calculateScaleOutScenario` so each lot uses its own assumption:
  target uses `targetPrice`, stop uses fixed stop or trailing stop estimate,
  fallback uses `fallbackPrice` when provided and otherwise returns `null` for
  the selected scenario.
- [ ] Update `ScaleOutScenarioCalculator` to show three presets:
  `All targets`, `Mixed`, `All stops`, plus per-lot outcome chips
  `Target / Stop / EOD`.
- [ ] Ensure changing scenario assumptions updates P/L only; it must not call
  any lot setters that change quantity/target/stop fields.
- [ ] Update `scaleOutScenario.test.ts` to cover:
  - all targets
  - mixed target/stop outcomes
  - fallback without price returns selected `null`
- [ ] Run:

```bash
npx vitest run src/modules/tws-execution-assistant/scaleOutScenario.test.ts
npm run typecheck
```

## Task 5: Final Visual And Safety Verification

**Files:**
- Verify changes are limited to:
  - `src/modules/tws-execution-assistant/ExecutionPlanFlowSheet.tsx`
  - `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`
  - `src/modules/tws-execution-assistant/BracketBuilderPanel.tsx`
  - `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`
  - `src/modules/tws-execution-assistant/AdvancedOrderPanel.tsx`
  - `src/modules/tws-execution-assistant/ScaleOutScenarioCalculator.tsx`
  - `src/modules/tws-execution-assistant/scaleOutScenario.ts`
  - `src/modules/tws-execution-assistant/scaleOutScenario.test.ts`

- [ ] Run:

```bash
npm run typecheck
git diff --check
npx vitest run src/modules/tws-execution-assistant/scaleOutScenario.test.ts
```

- [ ] Browser smoke `http://localhost:1420/tws`:
  - Standard cyan, Scale-Out purple, Bracket orange, Advanced blue.
  - Dark and light theme both preserve readable contrast.
  - No duplicated connection status in symbol row.
  - `conid` is read-only metadata.
  - No long anatomy panels remain.
  - Chart plan lines remain separate from Execution Plan.
  - Scale-Out scenario assumptions update the math and do not change order lot fields.

- [ ] Stop after this slice and report files changed, verification output, and
  any visual gaps. Do not widen into chart, Positions, Open Orders, broker
  package mutation, or backend behavior.
