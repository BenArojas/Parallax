# TWS Plan Chart Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Follow `docs/testing.md` for test scope — this feature adds zero new tests (frontend draft-form editing only, no critical promise threatened); each task verifies via `npm run typecheck` plus manual smoke.

**Goal:** Draggable plan price lines on the TWS candle chart with two-way binding to the standard plan form, scale-out ladder builder, and bracket builder, behind an on-by-default toggle — per the approved spec `docs/superpowers/specs/2026-07-02-tws-plan-chart-lines-design.md`.

**Architecture:** A `PlanChartLine[]` prop on `TwsCandleChart`, which owns all rendering (diffed `createPriceLine`/`applyOptions`/`removePriceLine`, never a full teardown) and all drag mechanics (manual mouse layer — lightweight-charts 5.1.0 has no native price-line drag; verified: `priceToCoordinate`/`coordinateToPrice`/`handleScroll`/`handleScale` all exist). The module builds standard-mode lines from `planForm`; ladder/bracket panels publish theirs upward via one `onChartLines(conid, lines)` callback prop and the module gates by conid match. Dragging edits draft form state only — no API calls, no order paths.

**Tech Stack:** React 19, TypeScript, lightweight-charts 5.1.0. Frontend only — zero backend changes.

---

## Global Constraints

- Dragging edits *draft form state* only — identical to typing in the field. No API call fires from a drag; no submitted order or package is ever touched.
- No new dependencies, no chart library changes.
- Line colors come from `readChartTheme()` (`upColor` targets, `downColor` stops) plus `#00d4ff` for entry — no new hardcoded palette.
- Panels keep owning their local state; the module never reaches into them (callback prop only).
- Trail exits (ladder lots with `use_trail`, bracket with `useTrail`) get **no** line — they have no fixed price.
- `AdvancedOrderPanel` is out of scope (deferred: `condition_price` line).

## File Map

- Modify `src/modules/tws-execution-assistant/TwsCandleChart.tsx`: `PlanChartLine` type, `planLines` prop, diff-rendering effect, drag layer.
- Modify `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`: toggle state + button (timeframe row, line ~1619), standard-mode lines memo, panel-lines state + gating + mismatch hint, pass `planLines` to the chart (line ~1650).
- Modify `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`: publish lines effect.
- Modify `src/modules/tws-execution-assistant/BracketBuilderPanel.tsx`: publish lines effect.
- Modify `PROJECT_PLAN.md`: kickoff (Task 0) and done (Task 4) notes.

## Interfaces

```ts
// TwsCandleChart.tsx — exported
export interface PlanChartLine {
  id: string;                         // stable per source field, e.g. "plan-limit", "ladder-t0"
  price: number;                      // already rounded to 0.01 by the source
  kind: "entry" | "target" | "stop";  // entry=#00d4ff, target=theme.upColor, stop=theme.downColor
  label: string;                      // axis label: "Entry", "T1", "S1", "Target", "Stop"
  onDrag: (price: number) => void;    // pushes a dragged price back into the source form state
}
// New chart prop: planLines?: PlanChartLine[]

// Panel prop added to ScaleOutLadderPanel and BracketBuilderPanel:
// onChartLines?: (conid: number, lines: PlanChartLine[]) => void
```

---

### Task 0: Record Feature Kickoff

**Files:**
- Modify: `PROJECT_PLAN.md`

- [ ] In `PROJECT_PLAN.md`, directly after the "TWS follow-up missions" bullet (line ~68), add:

```markdown
- **TWS plan chart lines:** IN PROGRESS on `feature/tws-plan-chart-lines` — draggable plan price lines on the TWS chart with two-way form binding (standard/ladder/bracket), on-by-default toggle. Spec `docs/superpowers/specs/2026-07-02-tws-plan-chart-lines-design.md`, plan `docs/superpowers/plans/2026-07-02-tws-plan-chart-lines.md`. Frontend-only; drafts only, never submitted orders.
```

- [ ] Commit:

```bash
git add PROJECT_PLAN.md
git commit -m "docs: start tws plan chart lines feature"
```

### Task 1: Line Rendering, Toggle, Standard-Plan Binding (tracer bullet)

**Files:**
- Modify: `src/modules/tws-execution-assistant/TwsCandleChart.tsx`
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`

- [ ] **TwsCandleChart.tsx** — add to the imports: `type IPriceLine` (from `lightweight-charts`). Add the exported `PlanChartLine` interface (Interfaces section above). Change the component signature to:

```tsx
export function TwsCandleChart({ bars, liveBar, planLines }: {
  bars: BarSnapshot[];
  liveBar?: BarSnapshot | null;
  planLines?: PlanChartLine[];
}) {
```

- [ ] Add three refs next to the existing ones (`draggingIdRef` is used by Task 2 but declared now so the diff effect below compiles unchanged later):

```tsx
const priceLinesRef = useRef<Map<string, { line: IPriceLine; price: number }>>(new Map());
const planLinesRef  = useRef<PlanChartLine[]>([]);
const draggingIdRef = useRef<string | null>(null);
```

- [ ] In the mount effect's cleanup (after `chart.remove()`), add `priceLinesRef.current.clear();`.
- [ ] Add the diff-rendering effect after the existing `[liveBar, bars]` effect. It never tears everything down — creates, moves, and removes only what changed, so there is no flicker:

```tsx
useEffect(() => {
  const candle = candleRef.current;
  if (!candle) return;
  const lines = planLines ?? [];
  planLinesRef.current = lines;
  const theme = readChartTheme();
  const colorFor = (kind: PlanChartLine["kind"]) =>
    kind === "target" ? theme.upColor : kind === "stop" ? theme.downColor : "#00d4ff";

  const held = priceLinesRef.current;
  const seen = new Set<string>();
  for (const spec of lines) {
    seen.add(spec.id);
    const entry = held.get(spec.id);
    if (!entry) {
      held.set(spec.id, {
        price: spec.price,
        line: candle.createPriceLine({
          price: spec.price,
          color: colorFor(spec.kind),
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: spec.label,
        }),
      });
    } else if (entry.price !== spec.price && draggingIdRef.current !== spec.id) {
      // draggingIdRef guard: while a drag is in flight, a stale prop echo of the
      // previous rAF commit must not snap the line back a frame (Task 2).
      entry.line.applyOptions({ price: spec.price });
      entry.price = spec.price;
    }
  }
  for (const [id, entry] of held) {
    if (!seen.has(id)) {
      candle.removePriceLine(entry.line);
      held.delete(id);
    }
  }
}, [planLines]);
```

- [ ] **TwsExecutionAssistantModule.tsx** — import `type PlanChartLine` from `./TwsCandleChart` and add next to the other `useState` calls (~line 396):

```tsx
const [showPlanLines, setShowPlanLines] = useState(true);
```

- [ ] Add the standard-mode lines memo near the other derived values. Reuse `priceFieldsFor` (already imported and used at ~line 713 — do not re-encode the order-type→fields mapping):

```tsx
const standardPlanLines = useMemo<PlanChartLine[]>(() => {
  const fields = priceFieldsFor(planForm.order_type);
  const lines: PlanChartLine[] = [];
  if (fields.includes("limit_price") && planForm.limit_price && planForm.limit_price > 0) {
    lines.push({
      id: "plan-limit", price: planForm.limit_price, kind: "entry", label: "Entry",
      onDrag: (p) => setPlanForm((f) => ({ ...f, limit_price: p })),
    });
  }
  if (fields.includes("stop_price") && planForm.stop_price && planForm.stop_price > 0) {
    lines.push({
      id: "plan-stop", price: planForm.stop_price, kind: "stop", label: "Stop",
      onDrag: (p) => setPlanForm((f) => ({ ...f, stop_price: p })),
    });
  }
  return lines;
}, [planForm.order_type, planForm.limit_price, planForm.stop_price]);

const EMPTY_LINES: PlanChartLine[] = useMemo(() => [], []);
const chartLines = !showPlanLines ? EMPTY_LINES
  : planMode === "standard" ? standardPlanLines
  : EMPTY_LINES; // scale_out/bracket wired in Task 3
```

- [ ] In the chart-header timeframe row (~line 1619, the `<div className="flex gap-0.5">` wrapping `TWS_TIMEFRAMES.map`), insert a toggle button before the timeframe buttons, mirroring their styling:

```tsx
<button
  onClick={() => setShowPlanLines((v) => !v)}
  title="Show plan prices as draggable lines on the chart"
  className={cn(
    "mr-1 rounded px-1.5 py-0.5 text-[9px] transition-colors",
    showPlanLines
      ? "bg-[var(--glow-cyan)] font-semibold text-[var(--clr-cyan)]"
      : "text-[var(--text-3)] hover:text-[var(--text-2)]",
  )}
>
  Lines
</button>
```

- [ ] Pass the prop at the chart mount (~line 1650): `<TwsCandleChart bars={barsData.bars} liveBar={liveBar} planLines={chartLines} />`.
- [ ] Run: `npm run typecheck` — expect no errors.
- [ ] Manual smoke: standard plan, LMT with a limit price → cyan Entry line appears; STP LMT → cyan + red lines; edit the field → line moves instantly; toggle off → lines vanish; switch symbol/timeframe → no flicker, no stale lines.
- [ ] Commit:

```bash
git add src/modules/tws-execution-assistant/TwsCandleChart.tsx src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx
git commit -m "feat: render plan price lines on the tws chart with toggle"
```

### Task 2: Drag Interaction (two-way binding complete for standard mode)

**Files:**
- Modify: `src/modules/tws-execution-assistant/TwsCandleChart.tsx`

- [ ] Inside the mount effect (after the series/`priceScale` setup, before `const ro = new ResizeObserver`), add the drag layer. `el`, `chart`, and `candle` are the effect's existing locals:

```tsx
// ── Plan-line dragging ── lightweight-charts has no native price-line drag.
const HIT_PX = 4;
let draggingId: string | null = null;
let rafId = 0;

const relY = (ev: MouseEvent) => ev.clientY - el.getBoundingClientRect().top;

const lineAt = (y: number): PlanChartLine | null => {
  for (const spec of planLinesRef.current) {
    const held = priceLinesRef.current.get(spec.id);
    if (!held) continue;
    const coord = candle.priceToCoordinate(held.price);
    if (coord !== null && Math.abs(coord - y) <= HIT_PX) return spec;
  }
  return null;
};

const onMouseDown = (ev: MouseEvent) => {
  const hit = lineAt(relY(ev));
  if (!hit) return;
  // Capture phase + stopPropagation: the chart canvas must never see this
  // mousedown, or it starts a pan gesture underneath the line drag.
  ev.preventDefault();
  ev.stopPropagation();
  draggingId = hit.id;
  draggingIdRef.current = hit.id;
  chart.applyOptions({ handleScroll: false, handleScale: false });
};

const onMouseMove = (ev: MouseEvent) => {
  const y = relY(ev);
  if (!draggingId) {
    const rect = el.getBoundingClientRect();
    const inside =
      ev.clientX >= rect.left && ev.clientX <= rect.right &&
      ev.clientY >= rect.top && ev.clientY <= rect.bottom;
    el.style.cursor = inside && lineAt(y) ? "ns-resize" : "";
    return;
  }
  const raw = candle.coordinateToPrice(y);
  if (raw === null) return;
  const price = Math.round((raw as number) * 100) / 100;
  if (price <= 0) return;
  const held = priceLinesRef.current.get(draggingId);
  const spec = planLinesRef.current.find((l) => l.id === draggingId);
  if (!held || !spec) return;
  held.line.applyOptions({ price }); // imperative — zero React work per frame
  held.price = price;
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => spec.onDrag(price)); // form update, latest wins
};

const onMouseUp = () => {
  if (!draggingId) return;
  const held = priceLinesRef.current.get(draggingId);
  const spec = planLinesRef.current.find((l) => l.id === draggingId);
  draggingId = null;
  draggingIdRef.current = null;
  chart.applyOptions({ handleScroll: true, handleScale: true });
  cancelAnimationFrame(rafId);
  if (held && spec) spec.onDrag(held.price); // final commit
};

el.addEventListener("mousedown", onMouseDown, true);
window.addEventListener("mousemove", onMouseMove);
window.addEventListener("mouseup", onMouseUp);
```

- [ ] Extend the mount effect's cleanup (before `chart.remove()`):

```tsx
el.removeEventListener("mousedown", onMouseDown, true);
window.removeEventListener("mousemove", onMouseMove);
window.removeEventListener("mouseup", onMouseUp);
cancelAnimationFrame(rafId);
```

- [ ] Run: `npm run typecheck` — expect no errors.
- [ ] Manual smoke: hover a line → `ns-resize` cursor; drag → line follows the pointer smoothly, the form field updates live, the chart does NOT pan; release → field holds the final 2-decimal value; drag while live candles stream → no jitter, no snap-back; normal chart panning/zooming still works away from lines.
- [ ] Commit:

```bash
git add src/modules/tws-execution-assistant/TwsCandleChart.tsx
git commit -m "feat: make tws plan chart lines draggable"
```

### Task 3: Ladder And Bracket Lines

**Files:**
- Modify: `src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx`
- Modify: `src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx`
- Modify: `src/modules/tws-execution-assistant/BracketBuilderPanel.tsx`

- [ ] **Module** — add `useCallback` to the react import on line 1 (currently `useMemo, useState, type ReactNode`). Then add panel-lines state and a STABLE callback (a `useCallback` with `[]` deps is required: an inline arrow would give the panels a new prop identity every render, retriggering their publish effects in a render loop):

```tsx
const [panelChart, setPanelChart] = useState<{ conid: number; lines: PlanChartLine[] }>({ conid: 0, lines: [] });
const handlePanelChartLines = useCallback(
  (conid: number, lines: PlanChartLine[]) => setPanelChart({ conid, lines }),
  [],
);
```

- [ ] Replace the `chartLines` merge from Task 1 with:

```tsx
const panelLinesMatch = panelChart.conid > 0 && panelChart.conid === planForm.conid;
const chartLines = !showPlanLines ? EMPTY_LINES
  : planMode === "standard" ? standardPlanLines
  : (planMode === "scale_out" || planMode === "bracket") && panelLinesMatch ? panelChart.lines
  : EMPTY_LINES;
const panelLinesMismatch =
  showPlanLines && (planMode === "scale_out" || planMode === "bracket") &&
  panelChart.lines.length > 0 && !panelLinesMatch;
```

- [ ] Pass `onChartLines={handlePanelChartLines}` to both `<ScaleOutLadderPanel …>` (~line 1385) and `<BracketBuilderPanel …>` (~line 1395).
- [ ] Below the chart-header row (inside the `border-b` div, after the flex row at ~line 1635), add the mismatch hint:

```tsx
{panelLinesMismatch && (
  <p className="mt-1 text-[9px] text-[var(--text-3)]">
    Plan lines hidden — the builder&apos;s symbol differs from the charted symbol.
  </p>
)}
```

- [ ] **ScaleOutLadderPanel.tsx** — add `useEffect` to the react import on line 1 (currently only `useState`), import `type PlanChartLine` from `./TwsCandleChart`, add `onChartLines?: (conid: number, lines: PlanChartLine[]) => void;` to the props type, and add after the state declarations (~line 153). Lot fields are strings (`LotInput`); `Number("") === 0` so empty inputs publish nothing; `use_trail` lots get no stop line:

```tsx
useEffect(() => {
  if (!onChartLines) return;
  const lines: PlanChartLine[] = [];
  const entry = Number(limitPrice);
  if (orderType === "LMT" && entry > 0) {
    lines.push({
      id: "ladder-entry", price: Math.round(entry * 100) / 100, kind: "entry", label: "Entry",
      onDrag: (p) => setLimitPrice(String(p)),
    });
  }
  lots.forEach((lot, i) => {
    const tp = Number(lot.target_price);
    if (tp > 0) {
      lines.push({
        id: `ladder-t${i}`, price: Math.round(tp * 100) / 100, kind: "target", label: `T${i + 1}`,
        onDrag: (p) => setLots((ls) => ls.map((l, j) => (j === i ? { ...l, target_price: String(p) } : l))),
      });
    }
    const sp = Number(lot.stop_price);
    if (!lot.use_trail && sp > 0) {
      lines.push({
        id: `ladder-s${i}`, price: Math.round(sp * 100) / 100, kind: "stop", label: `S${i + 1}`,
        onDrag: (p) => setLots((ls) => ls.map((l, j) => (j === i ? { ...l, stop_price: String(p) } : l))),
      });
    }
  });
  onChartLines(conid, lines);
}, [onChartLines, conid, orderType, limitPrice, lots]);

useEffect(() => () => onChartLines?.(0, []), [onChartLines]);
```

- [ ] **BracketBuilderPanel.tsx** — same import additions (`useEffect` to the react import on line 1, `type PlanChartLine`) and the same prop; add after the state declarations (~line 111). Price states are strings; trail mode suppresses the stop line:

```tsx
useEffect(() => {
  if (!onChartLines) return;
  const lines: PlanChartLine[] = [];
  const entry = Number(limitPrice);
  if (orderType === "LMT" && entry > 0) {
    lines.push({
      id: "bracket-entry", price: Math.round(entry * 100) / 100, kind: "entry", label: "Entry",
      onDrag: (p) => setLimitPrice(String(p)),
    });
  }
  const tp = Number(targetPrice);
  if (tp > 0) {
    lines.push({
      id: "bracket-target", price: Math.round(tp * 100) / 100, kind: "target", label: "Target",
      onDrag: (p) => setTargetPrice(String(p)),
    });
  }
  const sp = Number(stopPrice);
  if (!useTrail && sp > 0) {
    lines.push({
      id: "bracket-stop", price: Math.round(sp * 100) / 100, kind: "stop", label: "Stop",
      onDrag: (p) => setStopPrice(String(p)),
    });
  }
  onChartLines(conid, lines);
}, [onChartLines, conid, orderType, limitPrice, targetPrice, stopPrice, useTrail]);

useEffect(() => () => onChartLines?.(0, []), [onChartLines]);
```

- [ ] Run: `npm run typecheck` — expect no errors.
- [ ] Manual smoke: scale-out mode, resolve a symbol (this also re-points the chart via the existing `onInstrumentResolved`) → entry + T1/T2/S1/S2 lines in three colors; drag T1 → the lot's target field updates; type in a lot field → line moves; a `use_trail` lot shows no stop line; bracket mode same for entry/target/stop; change the standard form's symbol so conids differ → lines disappear and the hint shows; switch back to standard mode → panel lines cleared, standard lines return.
- [ ] Commit:

```bash
git add src/modules/tws-execution-assistant/TwsExecutionAssistantModule.tsx src/modules/tws-execution-assistant/ScaleOutLadderPanel.tsx src/modules/tws-execution-assistant/BracketBuilderPanel.tsx
git commit -m "feat: publish ladder and bracket lines to the tws chart"
```

### Task 4: Roadmap Update And Final Verification

**Files:**
- Modify: `PROJECT_PLAN.md`

- [ ] Update the Task 0 bullet in `PROJECT_PLAN.md` from IN PROGRESS to DONE, one sentence on what shipped.
- [ ] Run:

```bash
npm run typecheck
npm run build
git diff --check
```

- [ ] Full manual smoke with the human present (TWS connected, live candles streaming): every item from Tasks 1-3's smoke lists, plus: no jank/latency while the stream patches the last bar during a drag; toggle state survives symbol and timeframe switches; existing order cancel/modify flows untouched.
- [ ] Commit:

```bash
git add PROJECT_PLAN.md
git commit -m "docs: mark tws plan chart lines done"
```

## Recommended Batches

- **Batch 1 (Tasks 0-2):** rendering + drag on the standard form — the complete interaction vertical; smoke needs TWS connected.
- **Batch 2 (Tasks 3-4):** ladder/bracket publishing + final verification; smoke with human present.
