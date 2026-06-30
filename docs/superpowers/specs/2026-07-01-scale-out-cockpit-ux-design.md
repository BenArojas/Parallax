# Scale-Out Cockpit UX Design

> Status: APPROVED
> Branch: `feature/tws-advanced-order-types`
> Date: 2026-07-01

## Problem

The scale-out ladder shipped as its own standalone panel, separate from the
existing single-order "Execution Plan" panel. User feedback: it doesn't
belong as a second panel, the builder UI (dense field grid) feels robotic,
and there's no explanation of what a scale-out ladder is or why each lot
needs its own stop/trail. Priorities for the fix: user experience and
visual/interaction consistency with the rest of the cockpit.

## Chosen Solution

Fold `ScaleOutLadderPanel` into the existing "Execution Plan" panel as a
second mode, switched by a segmented pill toggle ("Standard" | "Scale-Out")
in the panel header, instead of a separate panel.

**Toggle + transition:** segmented pill in the panel header. On switch to
Scale-Out, a brief (~300-400ms) violet light-sweep animates left-to-right
across the top of the panel and the panel's accent shifts from
`--clr-cyan`/`--glow-cyan` to `--clr-purple`/`--glow-purple` (both already
defined in `src/styles.css` for dark and light themes — no new tokens).
Switching back to Standard reverses the accent and skips the sweep.

**Copy:** one intro blurb shown only when Scale-Out mode is first opened,
technical-but-warm voice:
> "Scale-out ladders split your exit across multiple price targets. Each lot
> gets its own protective stop (or trailing stop) and an end-of-day
> fallback — so a partial fill can never leave shares unprotected."

Field labels stay terse (Qty, Target, Stop, Trail) — the warmer tone is
scoped to this one intro block, not field-level copy. A "↻ Try an example"
button pre-fills a realistic 3-lot scenario so the form is never a blank
grid.

**Lot builder layout:** one card per lot (numbered badge, not a grid row),
each showing its own qty/target/stop-or-trail inputs plus a live
plain-English readout line, e.g. "→ sell 5 @ $125, protected by a stop at
$118." `?` tooltip icons (hover) on jargon fields (Stop, Trail, and OCA/
parent terminology in the preview step) explain what they mean in plain
language — IBKR-specific vocabulary is never assumed knowledge. A summary
row below the cards shows total shares and a proportional bar across lots.

**Consistency requirements:**
- Use the existing `Panel`/hero-band/detail-grid visual patterns already
  established in the single-order flow where they fit (e.g. the preview
  step's leg table keeps the existing role/side/qty/type/parent/OCA/transmit
  columns — only the *input* side changes, not the preview/submit
  contract).
- All colors via existing CSS variables (`--clr-*`, `--glow-*`, `--bg-*`,
  `--text-*`, `--border`) — no hardcoded hex, so dark/light theme and
  `ThemeToggle` keep working.
- Reuse existing `twsApi` calls (`previewOrderPackage`, `placePaperOrderPackage`,
  `placeLiveOrderPackage`) and `isLiveSession`/`canDraft` plumbing already
  wired in `TwsExecutionAssistantModule.tsx` — no new API surface.

## Out of Scope

- No backend/contract changes — `TwsOrderPackageRequest`/`Preview`/
  `Submission` shapes are unchanged; this is purely a frontend
  composition + copy + animation change.
- No redesign of the single-order ("Standard") mode beyond the new toggle
  living in its header.
- No changes to brackets/trailing/GTD/MOC/LOC/condition UI — still out of
  scope per Mission 2's hard limits.
- No persistence of which mode (Standard/Scale-Out) was last selected.

## Verification

No new critical promise is introduced (no broker/contract behavior changes),
so per `docs/testing.md` this is a manual-smoke-only change: `npm run
typecheck`, then a visual check in the running app that both modes render,
the toggle animates, and a paper preview/submit round-trip still works
through the merged panel exactly as it did through the standalone panel.

## Policy Impact

None. No broker behavior, persistence, or local/cloud policy changes.
