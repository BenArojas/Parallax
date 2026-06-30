# TWS Advanced Order Types Design

> Status: DRAFT FOR REVIEW
> Branch: `feature/tws-advanced-order-types`
> Date: 2026-06-30
> Revised: 2026-07-01 — repaired scale-out parent/child construction after
> live paper-account testing showed the original single-shared-parent design
> was unsafe. See "Locked Design Choices" and "Per-Lot Parent Isolation" below.

## Goal

Add advanced TWS order packages that a user can review and explicitly send:
scale-out ladders, brackets, trailing stops, good-till-date orders,
market-on-close, limit-on-close, and one narrow price-condition slice. Orbit
never adjusts orders on its own after the user sends them.

## Plain-English User Stories

- **Scale-out breakout:** User buys 20 shares of INTC at 120 and wants to sell
  5 at 125, 5 at 130, and 10 at 135. Orbit previews one entry order per lot
  (5, 5, and 10 shares) plus every exit lot before sending. Each lot has its
  own linked parent entry and its own linked exit group: target sell, stop or
  trailing stop sell, and market-on-close fallback sell.
- **Prevent accidental short:** If the 125 and 130 targets fill, then the
  remaining 10 shares stop out, Orbit must not leave another sell order that can
  create a short position. Lot groups are sized so the same shares cannot be
  sold twice — enforced by giving each lot its own parent entry order so TWS
  cannot merge one lot's exits with another's (see "Per-Lot Parent Isolation").
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
- **A package never shares one parent order across independent exit groups.**
  Each independently-protected group (e.g. each scale-out lot) gets its own
  parent entry order, sized to that group only. See "Per-Lot Parent Isolation."

## Per-Lot Parent Isolation

Confirmed against a real paper TWS account on 2026-07-01: TWS auto-links every
order that shares one `parentId` into a single OCA-managed cohort, **regardless
of any custom `ocaGroup` string the client sets**. The original design attached
all of a scale-out ladder's exit legs (across every lot) to one shared parent
entry order, scoping them into per-lot OCA groups via distinct `ocaGroup`
strings only. In practice, TWS ignored those distinct strings, merged every
lot's exits into one broker-assigned OCA group, and normalized every exit
order's quantity to the parent's full size — silently breaking the
"lot groups are sized so the same shares cannot be sold twice" promise.

The fix: build **one parent entry order per lot**, sized to that lot's own
quantity, with only that lot's target/stop-or-trail/MOC-fallback attached to
it. TWS's auto-OCA-via-`parentId` behavior then only ever scopes to the one
lot that legitimately shares that parent, so lots can never cross-contaminate
regardless of what TWS does with the `ocaGroup` field. The user-facing preview
still presents one logical package; only the broker order graph underneath
has N parent legs instead of one. This pattern applies to every future kind
that uses multiple independently-protected exit groups under one logical
package (bracket's single group is unaffected — it already has exactly one
parent for its one group).

Sources: [TWS API: One Cancels All](https://interactivebrokers.github.io/tws-api/oca.html),
[TWS API: Placing Orders](https://interactivebrokers.github.io/tws-api/order_submission.html)
("ParentId links the children to the parent, and IB uses this to establish
the OCA relationship automatically").

## Implementation References

- IBKR docs define parent/child transmit sequencing, OCA cancellation,
  good-till-date, and time-in-force values.
- `ib_async` 2.1.0 provides `IB.bracketOrder`, `IB.oneCancelsAll`, and `Order`
  fields for parent links, OCA, trailing percent, good-till-date, and close
  auction order types.

## Execution Plan Slices

1. Preview and validate scale-out ladder packages without placing orders. DONE.
2. Submit scale-out ladders through TWS with live-policy recheck and staged
   transmit sequencing. DONE — repaired 2026-07-01 to isolate each lot under
   its own parent entry order (see "Per-Lot Parent Isolation").
3. Reconcile order packages by parent, OCA group, status, and quantity
   warnings. `OrderSnapshot` already exposes `parent_id`/`oca_group`/
   `order_ref`; quantity-warning surfacing is still open.
3.5. Minimal cockpit UI for scale-out preview and paper/live submit — pulled
     forward as a vertical slice rather than waiting for slice 8, so the
     repaired design is reviewable end-to-end before later kinds reuse the
     same order builder.
4. Add bracket preview and submit.
5. Add trailing stop and trailing stop limit, including fixed and percent trail.
6. Add good-till-date, market-on-close, and limit-on-close simple orders.
7. Add one price-condition order slice.
8. Round out cockpit UI for the remaining kinds (bracket, trailing, GTD,
   MOC/LOC, price condition) and visible package status beyond scale-out.

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
