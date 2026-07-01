# Scale-Out Cockpit V2 Design

> Status: APPROVED
> Branch: `feature/tws-advanced-order-types`
> Date: 2026-07-01

## Problem

The current scale-out cockpit works, but it still feels like a raw order-entry
form. Users must enter `conid` manually, the lot cards use heavy boxed inputs,
and Open Orders shows linked scale-out legs as unrelated rows. That hides the
main safety fact: a scale-out ladder is a package, not separate orders.

## User Story

A trader searches `INTC`, Orbit resolves the correct instrument and `conid`,
then drafts a 20-share buy at 120 split into target lots. Before sending, Orbit
shows the best case, worst fixed-stop case, and an interactive partial-fill
scenario. After sending, Open Orders groups the package so the trader sees each
lot's entry, target, protection, and market-on-close fallback together.

If the trader wants to edit a scale-out leg, Orbit does not open the normal
single-order Modify form. It explains that the leg belongs to a linked package
and routes the trader to package management, because changing one quantity can
require matching changes to target, stop, and fallback legs.

## Chosen Solution

First implementation slice: upgrade scale-out planning and read-only package
visibility without adding new broker mutation behavior.

- Reuse the Standard plan symbol search path for Scale-Out. The user types a
  symbol and searches; `conid` becomes resolved metadata, not a required manual
  field.
- Restyle the lot builder into compact trade stages: softer surfaces, quieter
  inputs, tabular numbers, less white-box weight, and no nested card clutter.
- Add a compact scenario calculator above `Preview ladder`:
  - three headline numbers: best case, worst fixed-stop case, selected scenario.
  - a small segmented control for targets hit: `0`, `1`, `2`, `All`.
  - a remaining-exit selector: `Stops` or `End of day close`, with one assumed
    close-price input.
  - a short numeric breakdown only for the selected scenario.
- Group Open Orders by package when `order_ref` matches
  `ORBIT:TWS:<package_id>:<role>`. Normal orders remain simple rows. Scale-out
  packages show a header and nested lot hierarchy.
- Replace per-leg `Modify` and per-leg `Cancel` on scale-out legs with
  `Manage package`. The first V2 slice may open a read-only management view, but
  it must not mutate package legs one at a time.

## Package Replace Design

Package replace belongs in the existing Execution Plan panel, not in the Open
Orders table or a modal. Open Orders selects the package; Execution Plan becomes
`Manage Scale-Out`.

The workbench has three compact areas:

- Header: symbol, package id, remaining shares, active lots, paper/live state,
  fallback/protection status, and warning count.
- Current vs Proposed: current lots on the left, editable proposed lots on the
  right, using the same cleaned-up lot editor as draft mode.
- Replace Review: exact broker mutations before submit, such as canceling old
  exit orders and placing replacement exit orders while leaving filled entries
  unchanged.

Actual package replace is a later broker-mutation slice. It must re-read current
TWS state at submit time, require explicit review, use the live trading gate in
live mode, and never rely on stale frontend package state.

## Out Of Scope

- No autonomous order repair.
- No database package persistence.
- No package-level replace mutation in the first V2 slice.
- No new advanced order kinds in this design slice.
- No claim that trailing-stop downside is exact; it is shown as an estimate
  because the trail moves after favorable price movement.

## Verification

The first slice is frontend/read-only plus existing API reuse, so verify with
`npm run typecheck` and manual cockpit smoke: symbol search resolves a scale-out
instrument, calculator values update as inputs change, Open Orders groups a
known scale-out package, and normal orders still show normal actions.

Package replace will need its own focused backend/frontend plan and broker-safety
tests before any live or paper mutation code is added.
