# TWS Advanced Order Types Design

> Status: DRAFT FOR REVIEW
> Branch: `feature/tws-advanced-order-types`
> Date: 2026-06-30

## Goal

Add advanced TWS order packages that a user can review and explicitly send:
scale-out ladders, brackets, trailing stops, good-till-date orders,
market-on-close, limit-on-close, and one narrow price-condition slice. Orbit
never adjusts orders on its own after the user sends them.

## Plain-English User Stories

- **Scale-out breakout:** User buys 20 shares of INTC at 120 and wants to sell
  5 at 125, 5 at 130, and 10 at 135. Orbit previews the entry and every exit lot
  before sending. Each lot has its own linked exit group: target sell, stop or
  trailing stop sell, and market-on-close fallback sell.
- **Prevent accidental short:** If the 125 and 130 targets fill, then the
  remaining 10 shares stop out, Orbit must not leave another sell order that can
  create a short position. Lot groups are sized so the same shares cannot be
  sold twice.
- **Bracket:** User buys 20 shares at 120 with one profit target and one stop.
  Orbit previews the parent buy, profit-taking sell, and stop-loss sell. TWS
  activates the children only after the parent fills.
- **Trailing stop:** User chooses a fixed trail, such as "sell if it drops $2
  from the high", or a percent trail, such as "sell if it drops 3% from the
  high". For attached orders, tracking starts after the parent fill.
- **Good till date:** User places an order with a chosen expiration date and
  time. Orbit sends a good-till-date order and shows the expiration in review.
- **Close orders:** Market-on-close sells at the close auction.
  Limit-on-close sells there only if the limit is met.

## Locked Design Choices

- Add a small TWS order-package path instead of stretching the single-order
  `ExecutionPlan` model.
- Keep package state process-local. No database persistence in this mission.
- Frontend sends typed package requests; backend validates and previews the exact
  order graph.
- Backend generates order IDs, parent/child links, and OCA group names.
- Backend owns TWS order construction inside `TwsBrokerAdapter`; `ib_async` types
  stay out of routers and frontend contracts.
- Live submit reuses the Mission 1 allowlist and armed-session gate, then the
  adapter rechecks immediately before any `placeOrder` call.
- Staged packages use `transmit=False` until the final child order so TWS does
  not route a partial package.
- Scale-out ladders are long-only. Short selling remains allowed only for
  simple/manual non-ladder orders with explicit warning and confirmation.
- Trailing stops support fixed amount and percent trail.
- Conditional orders are last and narrow: one price condition only.

## Implementation References

- IBKR docs define parent/child transmit sequencing, OCA cancellation,
  good-till-date, and time-in-force values.
- `ib_async` 2.1.0 provides `IB.bracketOrder`, `IB.oneCancelsAll`, and `Order`
  fields for parent links, OCA, trailing percent, good-till-date, and close
  auction order types.

## Execution Plan Slices

1. Preview and validate scale-out ladder packages without placing orders.
2. Submit scale-out ladders through TWS with live-policy recheck and staged
   transmit sequencing.
3. Reconcile order packages by parent, OCA group, status, and quantity warnings.
4. Add bracket preview and submit.
5. Add trailing stop and trailing stop limit, including fixed and percent trail.
6. Add good-till-date, market-on-close, and limit-on-close simple orders.
7. Add one price-condition order slice.
8. Add cockpit UI for the package review flow and visible package status.

## Non-Goals

- No autonomous order management.
- No background revisions after the user sends a package.
- No hidden retry loop.
- No overnight scale-out ladders.
- No short scale-out ladders.
- No broad condition builder in this mission.
- No account, subscription, or broker-setting automation.

## Verification

Follow `docs/testing.md`. Add focused public-boundary tests only for uncovered
critical promises: invalid packages fail before broker calls, live packages fail
without an armed session, and submitted packages preserve parent/OCA/transmit
relationships. Manual TWS smoke requires the human present.
