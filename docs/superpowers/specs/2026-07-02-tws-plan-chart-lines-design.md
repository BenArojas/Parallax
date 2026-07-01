# TWS Plan Chart Lines Design

> Status: DESIGN APPROVED
> Branch: `feature/tws-plan-chart-lines` (off `feature/tws-live-advanced-market-data-design`, post Mission 3 Task 6)
> Date: 2026-07-02

## Goal

Show a plan's prices as draggable horizontal lines on the TWS candle chart, with
two-way binding: editing a form field moves its line, dragging a line updates the
field. Covers the standard plan form (limit/stop), the scale-out ladder builder
(entry + per-lot targets/stops), and the bracket builder (entry/target/stop).
A toggle button above the chart shows/hides the lines (on by default).

## Approved Decisions

- Entry limit prices get lines too (third color), not just targets/stops.
- Ladder/bracket lines render only when the builder's conid equals the charted
  `planForm.conid`; on mismatch the panels publish no lines and a small hint
  near the toggle explains why.
- Toggle defaults to on; plain session state, not persisted.
- Dragging edits draft form state only — identical in effect to typing in the
  field. No API calls from drag, no order mutation, no trading-safety surface.

## Architecture

Line-registry via props (no state lifting, no context, no chart ref API):

- `PlanChartLine { id: string; price: number; kind: "entry" | "target" | "stop";
  label: string; onDrag: (price: number) => void }` — defined in
  `TwsCandleChart.tsx`.
- `TwsCandleChart` gains a `planLines?: PlanChartLine[]` prop and owns ALL
  rendering and drag mechanics. It keeps an `id → IPriceLine` map in a ref and
  diffs on prop change: `applyOptions({ price })` for moves, create/remove only
  on set changes — never a full teardown, so no flicker.
- Sources: `TwsExecutionAssistantModule` builds standard-mode lines from
  `planForm` (limit_price when order type is LMT/STP LMT; stop_price when
  STP/STP LMT). `ScaleOutLadderPanel` and `BracketBuilderPanel` publish theirs
  through a new optional `onChartLines?: (lines: PlanChartLine[]) => void` prop
  from an effect keyed on their price/lot state (cleared to `[]` on unmount and
  on conid mismatch). Trail-mode exits publish no line (no fixed price). Only
  inputs parsing to a positive number produce lines. The module merges by
  `planMode` and passes the result (or `[]` when toggled off) to the chart.

## Drag Mechanics (inside TwsCandleChart)

lightweight-charts v5 has no native price-line dragging (verified against
installed 5.1.0: `createPriceLine`/`removePriceLine`/`IPriceLine.applyOptions`,
`priceToCoordinate`/`coordinateToPrice`, `handleScroll`/`handleScale` options).
Manual DOM mouse layer on the container:

- Hover: hit-test pointer y against each line via `priceToCoordinate`; within
  4px → `ns-resize` cursor.
- Drag: on mousedown near a line, disable `handleScroll`/`handleScale`; on
  mousemove, `coordinateToPrice(y)` → round to 0.01 → `applyOptions({ price })`
  immediately (imperative, zero React churn) and propagate via `onDrag`
  throttled through `requestAnimationFrame` (latest wins). On mouseup, re-enable
  scroll/scale and commit the final value.
- Loop closure: the form update returns as a new `planLines` prop whose rounded
  price equals the line's current price — the differ treats it as a no-op, so
  there is no jitter and no applyOptions churn.

## Visuals

- Targets: `readChartTheme().upColor`; stops: `downColor`; entry: solid cyan
  `#00d4ff` (matches the crosshair accent already used in this chart).
- Axis labels: `Entry`, `T1`…`Tn`, `S1`…`Sn` (`Stop`/`Target` for single-exit
  bracket). 1px solid lines, `axisLabelVisible: true`.
- Toggle: small button in the existing timeframe-button row above the chart
  (`TwsExecutionAssistantModule.tsx` ~1620), styled like the timeframe buttons.

## Out of Scope (deferred)

- AdvancedOrderPanel lines (`condition_price` is the natural follow-up).
- Lines for submitted orders/packages (draft forms only).
- Persisting the toggle; snapping beyond 0.01 rounding; touch support.

## Testing

Zero new tests per `docs/testing.md` — no critical promise threatened (no order
paths, no backend changes; frontend draft-form editing only). Manual smoke:
field↔line round-trip per mode, drag each line kind, toggle on/off, ladder
symbol-mismatch hint, no jank while live candles stream into the same chart.
