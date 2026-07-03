# TWS Execution Plan Anatomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact Plan Anatomy surface so Execution Plan explains order logic while the existing TWS chart keeps price-level visualization.

**Architecture:** Keep the slice frontend-only. Create one reusable anatomy presentation component, wire it into Standard, Bracket, Scale-Out, and Advanced draft modes, and derive copy from existing local state. Do not change package preview/submit contracts.

**Tech Stack:** React 19, TypeScript, Tailwind v4 utility classes, existing Orbit CSS variables, existing `twsApi` package endpoints.

## Global Constraints

- The TWS chart remains the only visual price-level surface; do not add a mini price map.
- No backend, API, broker, persistence, or live-trading policy changes.
- Use existing Orbit CSS variables: `--clr-*`, `--glow-*`, `--bg-*`, `--text-*`, `--border`.
- Completed slices: Bracket, Standard, Scale-Out, and Advanced.
- Optional Advanced chart-line support is deferred until condition/close/trailing line semantics are designed for the real chart.
- Per `docs/testing.md`, no new tests are required because this does not alter a critical trading promise.

---

## File Structure

- Create `src/modules/tws-execution-assistant/PlanAnatomyPanel.tsx`
  - Owns the reusable anatomy rendering: steps, broker effects, compact visual styling.
  - Has no API calls and no broker behavior.
- Modify `src/modules/tws-execution-assistant/BracketBuilderPanel.tsx`
  - Imports `PlanAnatomyPanel`.
  - Builds bracket anatomy from existing local form state.
  - Places the anatomy panel under the bracket intro copy and above the input grid.
- Modify `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`
  - Builds Standard anatomy from existing `planForm` and draft validation.
  - Places the anatomy panel under the Standard field grid.
- Modify `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`
  - Builds Scale-Out anatomy from existing entry/lot state.
  - Places the anatomy panel before the ladder inputs.
- Modify `src/modules/tws-execution-assistant/AdvancedOrderPanel.tsx`
  - Builds subtype-specific anatomy for Trailing Stop, GTD, MOC, LOC, and Price Condition.
  - Replaces long explanatory callouts with operational anatomy.
- Modify `PROJECT_PLAN.md`
  - Records the UI follow-up before coding begins and marks it complete after verification.

## Task 1: Bracket Plan Anatomy Tracer Slice

**Files:**
- Create: `src/modules/tws-execution-assistant/PlanAnatomyPanel.tsx`
- Modify: `src/modules/tws-execution-assistant/BracketBuilderPanel.tsx`
- Modify: `PROJECT_PLAN.md`

**Interfaces:**
- Consumes: bracket builder state (`symbol`, `side`, `quantity`, `orderType`, `limitPrice`, `targetPrice`, `useTrail`, `stopPrice`, `trailValue`).
- Produces: a read-only anatomy panel rendered inside bracket draft mode before preview.

- [ ] **Step 1: Update roadmap before coding**

Add one active roadmap note under the TWS roadmap area in `PROJECT_PLAN.md`:

```markdown
- **TWS Execution Plan Anatomy (in progress, `feature/tws-execution-plan-anatomy`, 2026-07-04):** UI-only follow-up to make Execution Plan explain order sequence, broker effects, and protection state without duplicating chart price lines. First tracer bullet is bracket mode only; no broker/API behavior changes. Design: `docs/superpowers/specs/2026-07-04-tws-execution-plan-anatomy-design.md`; plan: `docs/superpowers/plans/2026-07-04-tws-execution-plan-anatomy.md`.
```

- [ ] **Step 2: Create the reusable anatomy component**

Create `src/modules/tws-execution-assistant/PlanAnatomyPanel.tsx` with these public types:

```tsx
export type PlanAnatomyTone = "cyan" | "green" | "red" | "orange" | "purple" | "blue";

export interface PlanAnatomyStep {
  tone: PlanAnatomyTone;
  label: string;
  title: string;
  detail: string;
  metaLabel?: string;
  metaValue?: string;
}

export interface PlanAnatomyEffect {
  label: string;
  value: string;
  detail: string;
  tone?: PlanAnatomyTone;
}

export interface PlanAnatomyPanelProps {
  title: string;
  subtitle: string;
  badge: string;
  steps: PlanAnatomyStep[];
  effects: PlanAnatomyEffect[];
}
```

The component must:

- Render a compact header with `title`, `subtitle`, and `badge`.
- Render steps as a vertical sequence with colored tone markers.
- Render broker effects as a compact responsive grid.
- Use `font-data` for values and existing CSS variables only.
- Avoid changing behavior: no hooks, API calls, or mutable state.

- [ ] **Step 3: Build bracket anatomy in `BracketBuilderPanel`**

Import the component:

```tsx
import { PlanAnatomyPanel, type PlanAnatomyEffect, type PlanAnatomyStep } from "./PlanAnatomyPanel";
```

Add local formatting helpers near `buildRequest`:

```tsx
function moneyInput(value: string): string {
  const n = Number(value);
  return n > 0 ? `$${n.toFixed(2)}` : "missing";
}

function quantityInput(value: string): string {
  const n = Number(value);
  return n > 0 ? String(n) : "missing";
}
```

Inside `BracketBuilderPanel`, after `req` is computed, derive:

```tsx
const entryText = orderType === "LMT" ? `LMT ${moneyInput(limitPrice)}` : "MKT";
const quantityText = quantityInput(quantity);
const protectText = useTrail ? `TRAIL $${Number(trailValue || 0).toFixed(2)}` : `STP ${moneyInput(stopPrice)}`;
const hasProtection = useTrail ? Number(trailValue) > 0 : Number(stopPrice) > 0;

const anatomySteps: PlanAnatomyStep[] = [
  {
    tone: "blue",
    label: "WHEN",
    title: "Immediately after submit",
    detail: "No condition gate. This bracket is ready once the user previews and submits it.",
    metaLabel: "State",
    metaValue: req ? "Ready" : "Draft",
  },
  {
    tone: "cyan",
    label: "ENTER",
    title: `${side} ${quantityText} ${symbol || "symbol"} · ${entryText}`,
    detail: "This parent entry controls when the target and protection legs become active.",
    metaLabel: "Role",
    metaValue: "Parent",
  },
  {
    tone: "green",
    label: "EXIT",
    title: `${side === "BUY" ? "SELL" : "BUY"} ${quantityText} ${symbol || "symbol"} · LMT ${moneyInput(targetPrice)}`,
    detail: "If this target fills, the protective exit is canceled.",
    metaLabel: "Cancels",
    metaValue: "Protection",
  },
  {
    tone: hasProtection ? "red" : "orange",
    label: "PROTECT",
    title: `${side === "BUY" ? "SELL" : "BUY"} ${quantityText} ${symbol || "symbol"} · ${protectText}`,
    detail: hasProtection
      ? "If this protection fires, the target exit is canceled."
      : "Add a fixed stop or trailing stop before previewing the bracket.",
    metaLabel: "Safety",
    metaValue: hasProtection ? "Protected" : "Missing",
  },
];

const anatomyEffects: PlanAnatomyEffect[] = [
  { label: "Broker effect", value: "3 linked orders", detail: "One parent entry and two child exits.", tone: "cyan" },
  { label: "Cancel rule", value: "OCA-style exits", detail: "Target and protection cancel each other.", tone: "purple" },
  {
    label: "Protection state",
    value: hasProtection ? "Covered after fill" : "Protection missing",
    detail: hasProtection ? "The intended package protects the filled entry." : "Preview stays disabled until protection is complete.",
    tone: hasProtection ? "green" : "orange",
  },
];
```

- [ ] **Step 4: Render anatomy in draft mode**

Place `PlanAnatomyPanel` in the bracket draft render immediately after the orange bracket intro block and before the first input grid:

```tsx
<PlanAnatomyPanel
  title="Bracket order logic"
  subtitle="The chart shows the prices. This explains the sequence, links, and protection state."
  badge={req ? "Ready to preview" : "Draft incomplete"}
  steps={anatomySteps}
  effects={anatomyEffects}
/>
```

Do not render it in the preview/submission table state for this slice.

- [ ] **Step 5: Verify**

Run:

```bash
npm run typecheck
git diff --check
```

Expected:

```text
npm run typecheck exits 0
git diff --check exits 0
```

Manual smoke target:

- Bracket draft renders without layout overflow inside the fixed Execution Plan panel.
- Changing side, quantity, entry type, target, stop/trail changes anatomy copy.
- Existing bracket chart lines still render and drag; no new mini price map appears.
- `Preview bracket` remains disabled until the existing `req` conditions are met.

- [ ] **Step 6: Commit**

```bash
git add PROJECT_PLAN.md docs/superpowers/specs/2026-07-04-tws-execution-plan-anatomy-design.md docs/superpowers/plans/2026-07-04-tws-execution-plan-anatomy.md src/modules/tws-execution-assistant/PlanAnatomyPanel.tsx src/modules/tws-execution-assistant/BracketBuilderPanel.tsx
git commit -m "feat: add tws bracket plan anatomy"
```

## Follow-Up Issues, Not Part Of This Slice

- Add `onChartLines` support to `AdvancedOrderPanel` only after condition/close/trailing chart-line semantics are explicitly designed.

## Task 2: Standard Plan Anatomy Follow-Up

**Files:**
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`
- Modify: `PROJECT_PLAN.md`

**Interfaces:**
- Consumes: existing Standard draft state (`planForm`) and existing validation (`saveDraftDisabledReason`).
- Produces: a read-only anatomy panel rendered inside Standard draft mode before review.

- [x] Add one active roadmap note in `PROJECT_PLAN.md`.
- [x] Reuse `PlanAnatomyPanel`; do not create a second component.
- [x] Derive `WHEN`, `ORDER`, broker effect, price requirement, and review gate copy from existing Standard state.
- [x] Render the panel under the Standard input grid and before derived notional value.
- [x] Verify with `npm run typecheck`, `git diff --check`, and focused TWS frontend package tests.

## Task 3: Scale-Out Plan Anatomy Follow-Up

**Files:**
- Modify: `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`

**Interfaces:**
- Consumes: existing Scale-Out draft state (`symbol`, `conid`, `orderType`, `limitPrice`, `lots`) and existing request readiness (`req`).
- Produces: a read-only anatomy panel rendered inside Scale-Out draft mode before preview.

- [x] Reuse `PlanAnatomyPanel`; do not create a second component.
- [x] Derive `WHEN`, `ENTRY`, per-lot exit/protection/fallback rows, broker effect, cancel rule, and protection state from existing ladder state.
- [x] Render the panel before the Scale-Out input grid.
- [x] Keep existing chart lines as the only price-line visualization.
- [x] Verify with `npm run typecheck` and focused TWS frontend package tests.

## Task 4: Advanced Plan Anatomy Follow-Up

**Files:**
- Modify: `src/modules/tws-execution-assistant/AdvancedOrderPanel.tsx`

**Interfaces:**
- Consumes: existing Advanced draft state and existing `buildRequest` readiness.
- Produces: a read-only anatomy panel rendered inside Advanced draft mode before preview.

- [x] Reuse `PlanAnatomyPanel`; do not create a second component.
- [x] Derive subtype-specific `WHEN`, `ORDER`, behavior, broker owner, and review gate copy for Trailing Stop, GTD, MOC, LOC, and Price Condition.
- [x] Replace the older Trailing Stop and Price Condition prose callouts with anatomy instead of stacking explanations.
- [x] Include the Price Condition `WHEN` gate without adding a duplicate price map.
- [x] Verify with `npm run typecheck` and focused TWS frontend package tests.

## Self-Review

- Spec coverage: covered Plan Anatomy, chart-line non-duplication, Standard/Bracket/Scale-Out/Advanced draft modes, no backend/API changes, and verification.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps.
- Type consistency: `PlanAnatomyStep`, `PlanAnatomyEffect`, and `PlanAnatomyPanelProps` are defined before use.
