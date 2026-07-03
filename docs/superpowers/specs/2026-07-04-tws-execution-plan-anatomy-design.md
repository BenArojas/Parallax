# TWS Execution Plan Anatomy Design

> Status: APPROVED
> Branch: `feature/tws-execution-plan-anatomy`
> Date: 2026-07-04

## Problem

The Execution Plan builders work, but the input surfaces still read like raw
forms. Labels, boxes, and preview buttons explain *what to type*, but not enough
about *what the order will do*. This is especially weak for linked broker
packages such as brackets, scale-outs, and price-condition packages, where the
important user question is sequence and dependency: when does the order arm,
which leg enters, which exits protect or take profit, and what cancels what.

A separate mini price map is not the right fix. Orbit already has real chart
plan lines: `PlanChartLine` renders entry/target/stop levels on the TWS chart,
supports drag-to-form updates for drafts, and locks lines after review or for
managed packages. Duplicating those levels inside Execution Plan would compete
with the chart instead of improving the form.

## Chosen Solution

Add a **Plan Anatomy** surface inside Execution Plan. The chart remains the
spatial price surface; Plan Anatomy explains order logic, broker effects, and
safety meaning.

The first tracer bullet is bracket mode because it proves the core anatomy
language with a small, high-signal package:

- `WHEN`: immediate submission, or later condition in advanced modes.
- `ENTER`: parent entry order, e.g. `BUY 20 TSLA · LMT 248.50`.
- `EXIT`: profit-taking target, e.g. `SELL 20 TSLA · LMT 260.00`.
- `PROTECT`: fixed stop or trailing stop, e.g. `SELL 20 TSLA · STP 242.00`.
- `BROKER EFFECT`: number of generated broker orders and linkage semantics.
- `CANCEL RULE`: for brackets, target and stop are OCA-style exits; filling one
  cancels the other.
- `SAFETY CHECK`: plain-language statement of whether the intended package
  leaves the filled entry protected.

The anatomy surface should be compact and operational, not a teaching article.
It should use existing Orbit variables (`--clr-*`, `--glow-*`, `--bg-*`,
`--text-*`, `--border`) and the current dense cockpit visual language. It should
not create nested card clutter.

## Expected Mode Mapping

- Standard: show `WHEN`, `ENTER`, and `BROKER EFFECT` only.
- Bracket: show `WHEN`, `ENTER`, `EXIT`, `PROTECT`, `CANCEL RULE`, and `SAFETY
  CHECK`.
- Scale-Out: show entry plus stages/lots, each lot's target/protection/fallback,
  and package-level safety summary.
- Price Condition: show `WHEN` as the condition gate, then the entry/package
  that arms after the condition.
- Trailing Stop: show trail mode/value as protection behavior; do not pretend
  the final trigger is a fixed price.

## Out Of Scope

- No broker, backend, or API contract changes.
- No new price-map component.
- No replacement of existing TWS chart plan lines.
- No autonomous order repair, persistence, package replacement, or new order
  mutation behavior.
- No broad redesign of Positions, Open Orders, or chart/depth panels.
- No draggable-line work for advanced modes in the first tracer bullet. If
  needed later, extend the existing chart-line system instead of adding a second
  visual price layer.

## Verification

This is frontend composition and copy only, with no new trading mutation path.
Per `docs/testing.md`, the first tracer bullet should use:

```bash
npm run typecheck
git diff --check
```

Manual smoke should confirm: bracket mode renders the anatomy, existing form
inputs still work, existing chart lines still render/drag for bracket prices,
preview still reaches the existing preview flow, and the anatomy copy updates
for missing stop/trail cases without implying an unprotected order is safe.

## Policy Impact

None. The design reinforces Orbit's decision-support boundary by making broker
effects and protection state clearer, but it does not change broker behavior,
live-trading policy, persistence, secrets, or data ownership.
