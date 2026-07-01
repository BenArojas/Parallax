# TWS Live, Advanced Orders, And Market Data Design

> Status: DESIGN APPROVED
> Branch: `feature/tws-live-advanced-market-data-design`
> Date: 2026-06-29

## Goal

Lock the next TWS Execution Assistant decisions before implementation. This is a
parent design spec, not an execution plan. After approval, create one execution
plan per mission, each with vertical tracer-bullet slices:

1. Live trading.
2. Advanced TWS order types.
3. Market-data extras.

## Baseline

The shipped TWS module already provides exclusive TWS session mode, launcher
gating, TWS / IB Gateway connection and reconciliation, quote snapshots,
read-only bars/chart context, paper order review/place, `MKT`, `LMT`, `STP`,
`STP LMT` drafts, visible-order cancel/modify, and advanced reject override
handling.

Current order actions are paper-gated by known paper ports. The current TWS
chart fetches historical bars over HTTP and does not live-update.

## Shared Policy

- Orbit remains decision support, never autonomous trading.
- All broker access stays behind FastAPI and `TwsBrokerAdapter`.
- `ib_async` types must not leak into routers, frontend contracts, database
  models, or module UI.
- TWS remains an exclusive broker session mode; Client Portal mutation modules
  stay gated while TWS is active.
- Unknown account, unknown port, stale live arm, kill switch, disconnected
  adapter, or rejected policy fails closed.
- Execution plans remain process-local unless a later approved mission explicitly
  adds persistence.
- Subscription/account-management automation stays out.

## Mission 1: Live Trading

The first mission implements live `place`, `cancel`, and `modify` for visible
TWS orders after the live session is explicitly armed.

Approved live policy:

- Live arming requires an explicit local allowlist of live ports/accounts.
- Live arming is session-level only.
- A live arm lasts until TWS disconnect, app close/backend restart, or account
  change.
- Live arm covers place, cancel, and modify.
- Backend rechecks allowlist and armed state immediately before forwarding every
  live mutation to TWS.
- Advanced rejects and ambiguous outcomes remain visible for live operations.

Non-goals:

- Autonomous trading.
- Hidden retries.
- Background order management.
- Live mutation without the active live arm.

Expected execution-plan slices:

1. Add live allowlist and live-arm state contract with fail-closed backend checks.
2. Surface live account/port status and arming UX in the TWS cockpit.
3. Route live place through the existing plan review flow with live policy checks.
4. Route live cancel/modify for visible open orders with the same policy checks.
5. Preserve advanced-reject and ambiguous-outcome visibility for live actions.

## Mission 2: Advanced Order Types

Advanced orders use an Orbit order-construction layer over TWS. Scale-out ladders
are the priority workflow.

Approved scale-out policy:

- Scale-out ladders are buy-entry / long-only for now.
- No short scale-out ladders.
- A ladder is submitted as one staged structure so protection exists as soon as
  the entry can fill.
- Each ladder contains multiple exit lots, each with quantity and target price.
- Each lot has its own OCA group: target sell, stop sell, and default MOC
  fallback sell.
- TWS owns cancellation after one exit in a lot fills, so filled targets/stops
  remove that lot's remaining fallback orders without Orbit constantly revising
  one global end-of-day order.
- Orbit previews parent/child/OCA relationships before submission and reconciles
  for display, warnings, and orphan detection.
- Short selling is allowed outside scale-out ladders only with clear warning and
  confirmation.

The mission also covers:

- Brackets.
- Trailing stops and trailing stop limits.
- OCA.
- GTD.
- MOC and LOC.
- Conditional orders.

Non-goals:

- Autonomous scaling.
- AI-generated ladders.
- Hidden order edits.
- Broker behavior simulation.
- Overnight scale-out ladders.
- Short scale-out ladders.

Expected execution-plan slices:

1. Prove one long-only scale-out ladder preview and validation path.
2. Submit one staged long-only ladder with per-lot OCA target/stop/MOC exits.
3. Reconcile ladder lots, filled exits, canceled siblings, and orphan states.
4. Add trailing stop and trailing stop limit support inside ladder/bracket flows.
5. Add standalone bracket/OCA/GTD/MOC/LOC/conditional order support in small
   public-boundary slices.

## Mission 3: Market-Data Extras

2026-07-02: kickoff tracked in `docs/superpowers/plans/2026-07-02-tws-market-data-extras.md`.

Market-data extras stay read-only and use a TWS-owned stream, separate from the
existing Client Portal `/ws`.

Approved stream policy:

- Add `/execution-assistant/ws` or an equivalent TWS websocket endpoint.
- The TWS cockpit subscribes only to the selected instrument/timeframe.
- Bootstrap chart data with historical bars, then stream live candle updates into
  the current chart.
- Stream quote updates for last, bid, ask, sizes, high/low, volume, and data
  type.
- Add Level 2/depth for the selected instrument when available.
- Add per-exchange entitlement guidance without automating subscription or
  account settings.
- Market-data failures never block cancel, modify, or safety actions.
- No market-data persistence beyond current session state.

Typed stream events:

- `tws_stream_status`
- `tws_quote`
- `tws_bar_update`
- `tws_depth_update`

Expected execution-plan slices:

1. Classify entitlement state: live, delayed, unavailable, partial, and
   exchange-specific permission failures.
2. Add TWS websocket connection, subscribe/unsubscribe, and stream status events.
3. Stream selected-instrument quote events into the quote strip.
4. Bootstrap chart with historical bars and update the active candle from live
   stream events.
5. Add Level 2/depth panel with visible unavailable states.
6. Add per-exchange guidance with no subscription automation.

## Testing Policy

Follow `docs/testing.md`. Default to zero new tests unless a changed behavior
threatens an uncovered critical promise.

Likely critical promises:

- Unsafe trades cannot happen: live mutations must fail closed when the live arm
  or allowlist is invalid.
- Main user workflows work end to end: live order place/cancel/modify and ladder
  preview/submit/reconcile must be inspectable.
- External failures stop safely and visibly: TWS disconnects, advanced rejects,
  entitlement failures, and ambiguous mutation outcomes must be explicit.

Use at most one public-boundary test per critical promise per slice unless a
separate review approves more.

## Human Approval Gates

Human approval is required before:

- Implementing live order mutation behavior.
- Persisting allowlists or any execution-plan state.
- Enabling short-selling UX.
- Adding account, subscription, or broker-setting automation.
- Changing TWS/Client Portal session exclusivity.

## Deferred

- Autonomous trading.
- AI-generated orders or ladders.
- Subscription purchasing/account automation.
- Overnight scale-out ladders.
- Short scale-out ladders.
- Persistent execution plans.
