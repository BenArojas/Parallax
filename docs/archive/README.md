# Archived Design Docs

These are **plans and specs for features that have already shipped**. They are
kept for historical reference only — they are not active/forward-looking design.
If you are an agent (Claude Code, Codex) or a human looking for the *current*
design of a system, look in `docs/superpowers/plans/`, `docs/superpowers/specs/`,
and `docs/ibkr-pacing.md` first. Only consult this folder when you need the
original rationale behind a shipped feature.

> Nothing here is dead weight to delete — these documents explain *why* shipped
> code looks the way it does. They were moved out of the active design folders
> so the active folders only hold docs that current work still builds on.

## Contents

| Feature | Plan | Spec |
| --- | --- | --- |
| AI prompt fact layer | `2026-05-24-ai-prompt-fact-layer.md` | `2026-05-24-ai-prompt-fact-layer-design.md` |
| MoonMarket portfolio | `2026-05-26-moonmarket-portfolio.md` | `2026-05-26-moonmarket-portfolio-design.md` |
| MoonMarket transactions | `2026-05-26-moonmarket-transactions.md` | `2026-05-26-moonmarket-transactions-design.md` |
| Today page / watchlists / triggers | `2026-05-20-today-page-watchlists-triggers-plan.md` | `2026-05-20-watchlists-triggers-design.md`, `2026-05-20-watchlists-triggers-recommendations.md` |
| Inflect basis backfill / recovery | `inflect-basis-backfill-general-plan.md`, `2026-06-02-inflect-basis-recovery-implementation-plan.md` | — |
| **Cloud + Hybrid AI (v2, shipped to dev)** — parent mission, slices 1–8 | `2026-06-15-orbit-v2-cloud-hybrid-ai.md` | `2026-06-05-orbit-v2-cloud-hybrid-ai-design.md` *(kept active — v2 still builds on it)* |
| AI Run Inspector + OpenRouter review | `2026-06-17-ai-run-inspector-openrouter-review.md` | — |
| AI Run Inspector UX lifecycle remediation | `2026-06-19-ai-run-inspector-ux-lifecycle-remediation.md` | — |
| AI provider controls simplification | `2026-06-18-ai-provider-controls-simplification.md` | `2026-06-18-ai-provider-controls-simplification-design.md` |
| Budget-first AI workflow | `2026-06-20-budget-first-ai-workflow.md` | `2026-06-20-budget-first-ai-workflow-design.md` |
| AI analysis data + grounding pipeline | `2026-06-21-ai-analysis-data-grounding-pipeline.md` | — |
| AI neutral-vs-rejected signal handling | — | `2026-06-21-ai-neutral-vs-rejected-handling-design.md` |
| AI streaming reliability (finish_reason + reformat context) | `2026-06-21-ai-streaming-reliability-finish-reason-reformat.md` | — |
| TWS Execution Assistant parent + shell/gating | `2026-06-26-tws-execution-assistant-implementation.md` | `2026-06-05-tws-execution-assistant-design.md` |
| TWS paper order MVP | `2026-06-27-tws-paper-order-mvp-plan.md` | — |
| TWS market data capability | `2026-06-27-tws-market-data-capability-plan.md` | — |
| TWS broker cockpit UI | — | `2026-06-27-tws-broker-cockpit-ui-design.md` |
| TWS terminal cockpit redesign | — | `2026-06-28-tws-terminal-cockpit-redesign.md` |
| TWS order management | `2026-06-28-tws-order-management-implementation.md` | `2026-06-28-tws-order-management-design.md` |
| TWS execution plan Flow Sheet | `2026-07-04-tws-execution-plan-flow-sheet-implementation.md` | `2026-07-04-tws-execution-plan-flow-sheet-design.md` |

## What was kept active (not archived)

Left in `docs/superpowers/` because v2 builds directly on them:

- `specs/2026-05-25-orbit-v1-design.md` — master v1 design
- `plans/2026-05-25-orbit-foundation.md` — app foundation
- MoonMarket **options** (foundation for the v2 dual-mode bot): the `2026-05-28-moonmarket-options*` and `2026-06-04-moonmarket-options-atm-review-fixes.md` docs
- **OrderTicket** (the real-money order path the v2 trade-manager extends): the `2026-05-26-orbit-orderticket*` and `2026-06-03-orderticket-trailing-rr-cash*` docs
- **Inflect** journal (the next module to build): `2026-06-01-inflect-journal-*`
- `docs/ibkr-pacing.md` — IBKR rate/pacing limits, needed for v2 automation
- **Cloud + Hybrid AI** master design: `specs/2026-06-05-orbit-v2-cloud-hybrid-ai-design.md` — the parent mission shipped, but v2 still builds on this design.
- **AI prompt grounding + evaluation loop:** `plans/2026-06-19-ai-prompt-grounding-evaluation-loop.md` — validator/grader/runner shipped, but live OpenRouter evaluation and prompt promotion never ran. This is the remaining semantic-reasoning track (prompt quality), kept active.

TWS follow-up work is tracked in `PROJECT_PLAN.md`; new live-trading,
advanced-order, and market-data-extra missions should get new specs/plans.

## What was deleted (recoverable via git history)

One-off completed bug-fix / polish / optimization plans with no forward value were
deleted, not archived (recover from git history if ever needed): analysis-page fix,
drawing-tools plan, fibonacci-improvements, phase8 dashboard optimization, chart
state bugs, fib UX bugs, layout-and-history, compare mode, and orbit launcher polish.
The `reference/moonmarket/` porting copy of the old MoonMarket app was also deleted.
