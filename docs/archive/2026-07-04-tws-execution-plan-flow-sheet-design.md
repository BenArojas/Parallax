# TWS Execution Plan Flow Sheet Design

> Status: SHIPPED to `dev`
> Branch: `feature/tws-execution-plan-anatomy`
> Date: 2026-07-04
> Mockup: `docs/archive/assets/2026-07-04-execution-plan-flow-sheet-reset.html`

## Problem

The previous Execution Plan Anatomy direction overcorrected. It added too much
text, created a separate visual language per order type, and produced boxes
inside boxes. The original problem remains: inputs should be compact, modern,
theme-aware, and pleasant without feeling alien or instructional-heavy.

## Chosen Solution

Replace the current draft builders with a single **Flow Sheet** visual system:

- One continuous card/sheet per mode, using hairline row separators instead of
  nested cards.
- Mode accents stay distinct: Standard cyan, Scale-Out purple, Bracket orange,
  Advanced blue.
- Symbol search is symbol-only: editable ticker input + real `Find` button.
  `conid` is read-only metadata. Do not duplicate connection status in the row.
- Inputs are compact editable cells/underlines. Segmented controls handle side,
  entry type, trail/rule options.
- Guidance is text-light: one plain-English sentence plus tiny inline status
  words. No long anatomy panels or teaching articles.
- Scale-Out keeps scenario math because it answers P/L outcomes, not chart
  price placement. The user can adjust each lot's assumed outcome: Target,
  Stop, or EOD/fallback. This does not edit real lot values.
- The chart remains the only entry/target/stop line surface.

## Mode Mapping

- Standard: symbol, side, quantity, entry type, entry price, one sentence,
  notional, review CTA.
- Bracket: Standard fields plus target and stop/trail fields, orange accent,
  bracket sentence, preview CTA.
- Scale-Out: Standard fields plus lot rows, purple accent, adjustable scenario
  math, scale-out sentence, preview CTA.
- Advanced: Standard fields plus rule subtype controls, blue accent, concise
  rule sentence, preview CTA.

## Out Of Scope

- No broker, backend, API, persistence, live-trading policy, or chart-line
  behavior changes.
- No second price map inside Execution Plan.
- No redesign of chart, Positions, Open Orders, package managers, or broker
  mutation behavior.
- No new order type semantics beyond existing draft/preview paths.

## Verification

Required:

```bash
npm run typecheck
git diff --check
npx vitest run src/modules/tws-execution-assistant/scaleOutScenario.test.ts
```

Manual browser smoke:

- Check dark and light theme.
- Check Standard, Scale-Out, Bracket, and Advanced use the same Flow Sheet
  grammar with their own accent color.
- Confirm chart plan lines still render separately and are not duplicated in
  Execution Plan.
- Confirm Scale-Out scenario assumptions update P/L without changing lot fields.

## Policy Impact

None. This is UI presentation and local frontend scenario math only. It does
not change broker behavior, live-trading gates, persistence, secrets, or data
ownership.
