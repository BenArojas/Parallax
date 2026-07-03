# TWS Cockpit Improvements — Working Plan

**Date:** 2026-07-04 · **Status:** awaiting human approval
**Goal:** faster-reacting cockpit + position-level decision support. Not a portfolio dashboard.

## Execution rules (for every slice)

- One slice = one branch `feature/tws-<slice-name>` from `dev`. If the previous
  slice isn't merged yet, stack on its branch and say so in the PR.
- Smallest diff that works. Follow existing patterns in the module. No TDD,
  zero new tests by default (`docs/testing.md`). Verification = typecheck +
  manual run against paper TWS.
- Hard review/testing only at the two checkpoints below.
- Stop and report after each slice. Do not start the next one.

## Order & checkpoints

1. Event-driven reconciliation
2. Positions table upgrade
3. Day P&L status strip
   — **Checkpoint A: review + hard test (data layer + table)**
4. Manage Position panel
5. Fill notifications
6. Risk-based sizing
   — **Checkpoint B: review + hard test (actions + polish)**

## Slice 1 — Event-driven reconciliation

**What:** push a `tws_recon_changed` event over the existing WS when orders/
positions change; frontend refetches reconciliation on receipt.
**Files:** `backend/services/tws_broker_adapter.py`,
`backend/models/tws_execution_assistant.py`,
`src/modules/tws-execution-assistant/useTwsLiveStream.ts`, module file.
**How:** subscribe `self._ib.orderStatusEvent`, `execDetailsEvent`,
`positionEvent` on connect → broadcast one tiny event (no payload beyond type)
to all registered stream sockets. Frontend: on event, invalidate the recon
query. Keep poll as fallback, raise `refetchInterval` 5000 → 30000. Remove the
manual "Refresh Open Orders" affordance.
**Done when:** a fill in paper TWS appears in Open Orders/Positions within ~1s
without manual refresh.

## Slice 2 — Positions table upgrade

**What:** drop ConID column; add Mkt Price, Daily P&L, Unrl P&L ($ and %),
Protection; row click points the chart; avg-cost line on chart.
**Files:** adapter (`get_reconciliation`), `tws_execution_assistant.py` models,
`api.ts` (`PositionSnapshot`), module file (table + chart lines).
**How:** build `PositionSnapshot` from `self._ib.portfolio()` (has
`marketPrice`, `marketValue`, `unrealizedPNL`) keyed to `positions()` for
anything portfolio misses. Daily P&L: `reqPnLSingle(account, "", conid)` per
held position, subscribe on connect/position-open, unsubscribe on close/
disconnect; cache latest `dailyPnL` on the adapter, read it in
`get_reconciliation`. Protection column: reuse the sell-exposure math in
`tws_order_packages.derive_package_warnings` to show `covered/total` or
`⚠ N unprotected`. Row click → existing `pointChartAt()`. Avg-cost line:
read-only dashed line via the existing plan-lines infra when charted symbol
has a position.
**Done when:** table shows live P&L on paper account (delayed entitlement is
fine — IB computes server-side); conid gone; clicking a row repoints chart
with avg-cost line.

## Slice 3 — Day P&L status strip

**What:** account-level "Day P&L: +$X" in the status bar next to position
count.
**How:** one `reqPnL(account)` subscription on the adapter, cache latest,
expose in `TwsStatusResponse.reconciliation_summary` (or a sibling field);
render colored green/red.
**Done when:** header shows day P&L updating without refresh.

## Slice 4 — Manage Position panel

**What:** per-position management panel in the left-panel slot (same slot as
package managers). Opens from a Manage button on the position row.
**Quantity model:** `managed qty` = shares covered by working Orbit package
exits (scale-out, bracket) — display only, link to package manager, partial
actions never touch it. `free qty` = the rest.
**Actions:** all through the existing plan preview → confirm flow, MKT or LMT
(LMT prefilled from bid/ask):
- **Close position** — panic button, whole position: new backend flatten
  endpoint = cancel ALL working exits on the conid (scale-out included) →
  await cancel confirmations → place close order. Typed errors per step; if a
  cancel fails, stop before the close and report what's still working.
- **Sell half / third / custom qty** — capped at free qty; disabled with a
  note when free qty is 0.
- **Double / add custom qty** — plain buy, no exit interaction.
**Files:** new `ManagePositionPanel.tsx`, module file wiring, adapter +
router + models for flatten.
**Done when:** on paper TWS — close flattens a position with working scale-out
exits without over-selling; sell-third respects free qty.

## Slice 5 — Fill notifications

**What:** toast on execution: "TSLA · SELL 10 @ 410.00 (target)". Uses the
`execDetailsEvent` wiring from slice 1 — add a typed `tws_fill` WS event with
symbol/side/qty/price, resolve role from `order_ref` when it's a package leg.
Reuse whatever toast primitive the app already has.
**Done when:** a paper fill toasts within ~1s.

## Slice 6 — Risk-based sizing

**What:** "Risk $" input beside Quantity in plan forms that have a stop price
(standard w/ stop, bracket, scale-out): qty = floor(risk / (entry − stop)).
Frontend-only arithmetic, pattern-match `ScaleOutScenarioCalculator`. Typing
risk sets quantity; editing quantity clears risk.
**Done when:** entering risk + entry + stop fills a sane quantity.

## Locked decisions

- Close = everything: bundled cancel-then-close includes scale-out legs.
- Partial actions exclude package-covered shares (scale-out is intraday,
  already managed).
- Daily P&L ships in slice 2, not deferred.
- ConID removed from display; stays the internal key everywhere.

## Non-goals

Reverse position, lot-aware partial sells, hotkeys, order templates, time &
sales, options chains, P&L analytics (Inflect), alerts (Parallax), account
dashboards (MoonMarket).
