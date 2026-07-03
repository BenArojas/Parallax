# Orbit — Project Plan

> Last updated: 2026-06-28
> Status: Parallax core v1 is code-complete on `dev` through the rules/fib-trigger closeout pass. Phase 8 E2E remains the v1 sign-off gate. Phase 9, Phase 10, Phase 11, and Phase 12 are merged to `dev`. Orbit consolidation Plans #1–#7 are merged to local `dev`: options chain, Inflect v1/basis recovery,OrderTicket trailing/RTH/R-R/cash-sizing and sidecar client contract refactor are now included. Live/manual IBKR paper-account smoke testing remains the release gate.
---

## IBKR Gateway — What We Learned (2026-04-14)

The auto-provision path (Option B: app downloads JRE + Gateway on first launch) is working. Key findings from getting it to authenticate end-to-end:

**The root cause of the Dispatcher 200 loop (post-2FA redirect back to login):**

Browsers block cookies whose `Domain` is a bare IP address (RFC 6265). The IBKR Gateway proxies session cookies from IBKR's servers (`.ibkr.com`) and remaps them to the local host. When the browser was at `https://127.0.0.1:5001`, the remapped cookies were silently dropped — the browser never stored the `JSESSIONID`. So when Dispatcher was called after 2FA, there was no session cookie → IBKR saw an unauthenticated request → returned 200 (login page).

**The fix:** `IBKR_GATEWAY_HOST = "localhost"` everywhere. `localhost` is a valid cookie domain; `127.0.0.1` is not. MoonMarket worked because Docker port-maps to `localhost`, not `127.0.0.1`.

**Other changes made during this work:**

- `conf.yaml` — mirrored MoonMarket's working config exactly: `ip2loc: false`, `ips.allow: ["*"]`, minimal property set. IBKR Gateway crashes on unknown properties — we stripped everything not confirmed to work (removed `authDelay`, `cors`, `serverOptions`, `ccp`, `proxyRemoteSsl`, `autoRestart`)
- Port — `5001` on all OSes. Port 5000 collides with macOS AirPlay Receiver
- Java 17 — kept. IBKR Gateway (Apr 2023 build, Vert.x/Netty) breaks on newer JVMs. Java 17 LTS is the safe choice
- Removed Docker files — `docker-compose.yml`, `ibkr-gateway/Dockerfile`, `ibkr-gateway/conf.yaml`. The auto-provision path owns the full lifecycle; Docker option was confusing and diverged
- `_ensure_conf_yaml` duplication removed — `reset_conf_yaml()` is the single write path
- `httpx.ReadTimeout` in `IBKRService._request` was unhandled — now caught and raised as `IBKRConnectionError`. `/gateway/status` catches it and returns a clean JSON response instead of crashing the ASGI handler

**What did NOT fix it (documented to avoid re-trying):**

- `ip2loc: false` alone — necessary but not sufficient
- `-Djava.net.preferIPv4Stack=true` JVM flag — not the issue
- Port 5001 vs 5000 — not the issue

---

## Decisions Made

These are locked in. Don't revisit unless something breaks.

| Decision | Choice | Why |
|---|---|---|
| Instrument scope | Any instrument IBKR supports | Focus is US equities/ETFs, but don't restrict — if IBKR has data, show it |
| Desktop framework | Tauri v2 | Local-only, lightweight, cross-platform |
| Charts | TradingView Lightweight Charts v5 | Familiar, open source, high quality |
| AI model | Local Ollama by default; fixed OpenRouter models after explicit cloud opt-in | Analysis owns the selected provider/model; direct-provider parity is deferred |
| AI input | Structured JSON (pre-computed signals) | Not raw OHLCV — cleaner, more reliable |
| AI scope | Full chat + signal card | Signal card on first response, then follow-up chat |
| Ollama lifecycle | Detect-only, never auto-install | Guide user, don't decide for them |
| Persistence | SQLite (local) | Survives restarts, shared across Orbit modules |
| Market data | IBKR Client Portal Web API (port 5001) | Staying with this — TWS is not the current data path. `IBKRService` owns the httpx transport. |
| TWS usage | v2 fourth-module execution assistant | TWS mode is exclusive: it enables the user-armed assistant and disables Client Portal-dependent modules until the session returns to Client Portal mode. |
| Multi-timeframe | Single chart + timeframe switcher | Simpler UX |
| Background scanner | Runs while app is open only | No system tray mode |
| Dynamic watchlists | Auto-populated by trigger rules | Separate from master IBKR watchlist |
| Fibonacci | Primary tool — auto swing + manual override | Ofek's core trading method |
| Trigger watchlist moves | Real IBKR watchlist manipulation | Stocks show in TWS/mobile too, not just Parallax |
| News candle detection | All 4 methods, user selects per rule | Evaluate which works best in practice |

---

## Orbit Active Roadmap Notes

These notes are intentionally tracked in the project plan because they affect the next Orbit/MoonMarket implementation passes.

- **Fibonacci swing selection fix:** SHIPPED to `dev` (`e04110d`, 2026-06-20; branch deleted). Reworked `IndicatorService._score_swing` primary-fib selection: removed `INSIDE_TOLERANCE` for strict wick-based status (played_out > broken), made `stretched_penalty` reward any active internal level (0.382/0.5/GP, importance-weighted), and rebalanced `DEFAULT_FIB_WEIGHTS` to sum to 1.0. Status-doc reword touched `backend/models`, `indicators.py`, and the parallax api contract. Design: `docs/superpowers/specs/2026-06-20-fibonacci-swing-selection-design.md`.
- **Budget-first AI workflow:** DONE on `feature/budget-first-ai-workflow`. Scoped architecture/testing docs are canonical, Claude imports/symlinks shared guidance, four duplicated domain skills are removed, and critical-promises testing replaces mandatory TDD. Verified with JavaScript syntax, policy-drift, structure, and diff checks; no runtime application behavior changed. Design and plan archived under `docs/archive/` (`2026-06-20-budget-first-ai-workflow-design.md`, `2026-06-20-budget-first-ai-workflow.md`).
- **Cloud + Hybrid AI:** SHIPPED to `dev` from `feature/orbit-v2-cloud-hybrid-ai-spec` (parent mission slices 1–8, including the manual OpenRouter smoke/review gate). Delivered: validated OpenRouter model selection, cloud payload preview, inspectable run receipts, provider controls owned by Analysis, fact-grounded signals with fail-closed validation, the AI Run Inspector + UX lifecycle, the data/grounding pipeline (true 1h/4h candle semantics, EMA fact grouping, sufficient history, explicit groundable price candidates), neutral-vs-rejected signal handling, and streaming reliability (`finish_reason` capture + reformat retry that preserves the original narrative). Local Ollama stays the default, cloud is explicit opt-in, keys stay in the OS keychain, and SQLite stores only opaque `api_key_ref` values. Master design (kept active): `docs/superpowers/specs/2026-06-05-orbit-v2-cloud-hybrid-ai-design.md`. Shipped plans/specs archived under `docs/archive/` (see its README index).
- **AI semantic-reasoning quality (remaining forward track):** the prompt-grounding evaluation loop is code-complete (deterministic validator, graders, HITL runner) but its **live OpenRouter evaluation and prompt promotion never ran** — this is the open track for improving semantic reasoning (e.g. "below" ≠ "broke below", prefer NEUTRAL when the only target is structurally remote, non-equity instrument handling). Run candidates one variable at a time through the existing harness; do not hand-tune the prompt by vibes. Also pending: use the newly captured `finish_reason` distribution from real runs to decide whether the cloud `max_output_tokens` cost cap needs raising (do not raise it speculatively). Plan (kept active): `docs/superpowers/plans/2026-06-19-ai-prompt-grounding-evaluation-loop.md`.
- **TWS Execution Assistant:** SHIPPED to `dev` from `feature/tws-execution-assistant-spec` (2026-06-29). Delivered the fourth TWS-only module, exclusive broker session mode, launcher/module gating, TWS/IB Gateway connection and reconciliation, quote snapshots with delayed/unavailable guidance, read-only bars/chart context, terminal-style cockpit layout, paper order review/place flow, STP/STP LMT draft support, cancel/modify for visible TWS open orders, and explicit advanced-reject override handling. Broker mutations stay behind `TwsBrokerAdapter`; no DB plan persistence, no autonomous trading, and no live trading enablement. Shipped TWS specs/plans are archived under `docs/archive/`.
- **TWS follow-up missions (design branch `feature/tws-live-advanced-market-data-design`):** parent decision-locking spec approved in `docs/superpowers/specs/2026-06-29-tws-live-advanced-market-data-design.md`. Mission order is (1) **Live trading** — DONE (manual smoke verified 2026-06-30 against a real IB Gateway live account); live place/cancel/modify require explicit allowlisted session arming, backend policy rechecks, and visible ambiguous-outcome handling; arm clears immediately on disconnect; plan archived in `docs/superpowers/plans/2026-06-29-tws-live-trading.md`. (2) **Advanced order types** — DONE (manual smoke verified 2026-07-01 against the live paper account) on `feature/tws-advanced-order-types`; shipped long-only scale-out ladders (per-lot parent isolation), brackets, trailing stops (fixed/percent, TRAILLMT), GTD, MOC, LOC, and a one-condition price-condition slice, plus a Scale-Out Cockpit V2 interlude (symbol search, scenario calculator, read-only package grouping) and per-package Open Orders identification (scale-out/bracket grouped rows, advanced-kind role badges); design `docs/superpowers/specs/2026-06-30-tws-advanced-order-types-design.md`, plan `docs/superpowers/plans/2026-07-01-tws-advanced-order-types.md`; Scale-Out Cockpit V2 design `docs/superpowers/specs/2026-07-01-scale-out-cockpit-v2-design.md`, plan `docs/superpowers/plans/2026-07-01-scale-out-cockpit-v2.md`. (3) **Market-data extras** — DONE (manual smoke verified 2026-07-02) on `feature/tws-live-advanced-market-data-design`; plan `docs/superpowers/plans/2026-07-02-tws-market-data-extras.md`. Shipped a shared entitlement-classification helper (10089/10090/10197, the last covering a competing-session lockout) reused by both the REST quote snapshot and the new stream; a TWS-owned `/execution-assistant/ws` endpoint broadcasting typed events; live quote streaming, live candle updates (`keepUpToDate` bars patched via `.update()`, never a full redraw), a Level 2 depth panel with an explicit unavailable state, and a dismissible per-exchange entitlement guidance note. All layered on top of the existing REST polling, which stays as the degrade-gracefully path; no order-mutation code paths touched. Subscription/account-management automation stayed out, per the Human Approval Gate. The follow-on draggable plan chart lines feature (its own plan/spec, tracked separately above) also landed on this branch.
- **TWS plan chart lines:** DONE on `feature/tws-plan-chart-lines` (manual smoke verified 2026-07-02) — shipped draggable plan price lines on the TWS chart with two-way form binding across standard/ladder/bracket modes, an on-by-default toggle, and drafts-only editing (no order paths touched). Grew slightly beyond the original frontend-only scope with owner sign-off: `InstrumentResult.company_name` (IBKR contract long name) now backs the chart header, plus small UX fixes found during smoke (review-time line/mode locking, symbol-switch field resets, entitlement-note layout, free-moving crosshair, neutral last-price line, panel symbol seeding across mode switches). Spec `docs/superpowers/specs/2026-07-02-tws-plan-chart-lines-design.md`, plan `docs/superpowers/plans/2026-07-02-tws-plan-chart-lines.md`.
- **TWS Execution Plan Anatomy:** DONE on `feature/tws-execution-plan-anatomy` (2026-07-04) — bracket draft mode shows Plan Anatomy (`WHEN`/`ENTER`/`EXIT`/`PROTECT` plus broker effect/cancel/protection state), and Standard draft mode now reuses the same UI-only anatomy surface for `WHEN`/`ORDER`, broker effect, price requirement, and review gate. The chart remains the only price-line surface; no broker/API behavior changed. Verified with `npm run typecheck`, `git diff --check`, and focused TWS frontend package tests. Design: `docs/superpowers/specs/2026-07-04-tws-execution-plan-anatomy-design.md`; plan: `docs/superpowers/plans/2026-07-04-tws-execution-plan-anatomy.md`.
- **TWS scale-out package cancel/modify (ad-hoc follow-on, `feature/tws-live-advanced-market-data-design`, 2026-07-03):** Manage Scale-Out was read-only; added whole-lot cancel (entry + all exits together — per-leg cancel was deliberately rejected, since canceling just a stop or just a target leaves the other exit live with nothing protecting the position) and price-only Modify. **Known limitation, by design, not a bug:** target/stop/moc-fallback legs carry an explicit IBKR `ocaGroup`, and IBKR refuses to revise an OCA-grouped order in place (error 10326 "OCA group revision is not allowed") — confirmed live, and the rejected resubmission *canceled* the order rather than leaving it untouched. `modify_order()` now guards against this before ever calling `placeOrder()` (any caller, not just this UI). Bracket legs are unaffected — TWS auto-links those via shared `parentId`, no explicit `ocaGroup` on the order, so in-place revision has always worked there. **To change a scale-out lot's target or stop price: cancel the lot and re-place it with the new price** — there is no in-place path for those two fields. Quantity edits stay deferred entirely (a lot's entry/target/stop must always share the same share count; coordinating that across legs needs its own design). Regression test: `test_modify_order_refuses_oca_grouped_order_before_calling_placeorder`. **Second, unrelated bug found in the same session:** entry-leg modify reported success but silently didn't persist the new price (UI flashed the new value, then reverted on refetch) — `modify_order()` called `placeOrder()` with `copy.copy(trade.order)`; `ib_async`'s `placeOrder()` treats a matching orderId as a modify and returns the *same* tracked `Trade` without copying the passed-in `Order`'s fields onto it, so `trade.order` (what `get_reconciliation()` reads) stayed on the old price regardless of what TWS accepted. Fixed by mutating `trade.order` in place instead of a detached copy — general to all modify paths, not scale-out-specific. Regression test: `test_modify_order_mutates_tracked_trade_so_reconciliation_reflects_new_price`. **Third bug, found while re-checking a previously deferred item:** `place_order()`/`place_order_package()`/`modify_order()` inferred an advanced-order reject by capturing error-399/201 messages and checking whether `orderStatus.status` had settled back to an "accepted" value — but `ib_async` classifies 399 as a warning code and deliberately sets `orderStatus.status` to the transient `ValidationError` bookkeeping value while explicitly keeping the order live, so "not yet PreSubmitted" raced against TWS's own follow-up status correction and produced false-positive rejects on plain informational 399s (e.g. a DAY order placed outside RTH). Fixed by switching all three methods to check `trade.advancedError` instead — `ib_async`'s own unambiguous signal, populated only when TWS attaches a real structured `advancedOrderRejectJson` payload. This also fixed a second bug for free: plain-text 399 messages previously failed JSON parsing in `_advanced_reject_from_raw`, since `trade.advancedError` is only ever populated with genuine JSON. Regression tests: `test_modify_order_ignores_399_style_warning_with_no_advanced_error`, `test_modify_order_raises_advanced_reject_with_parsed_override_codes`.
- **Plan #6: MoonMarket Options Chain** ships single-leg option orders first. Selecting a call/put contract opens the shared OrderTicket as `OPTION`, but option brackets are disabled in the UI and rejected server-side if an option order payload tries to submit a multi-order group.
- **OrderTicket enhancement pass:** trailing stops (`TRAIL`/`TRAILLMT`), outside-RTH, plain-English labels, risk/reward readout, cash sizing, and percent-of-buying-power sizing are merged to local `dev`.
- **Deferred but required follow-up:** option bracket orders belong in a later MoonMarket trading-depth pass after single-leg option orders are validated against the IBKR paper account. Revisit this before any options trading polish or "bracket parity" work.
- **Parallax v1 status:** Parallax v1 has shipped. v2 work should not reopen shipped v1 scope unless a regression is found.
- **Compare-mode color customization:** still belongs in v1 polish because the hardcoded white stock line is not visible enough in light mode.
- **v2 strategic direction:** the major v2 themes are (1) a TWS-gated execution assistant, (2) optional cloud LLM + hybrid local/frontier inference, and (3) the fib learning/confluence roadmap. These do not change the local-first default.
- **Agent readiness (docs + discovery slice, branch `feature/agent-readiness`):** Applied the Forter agentic-readiness pillars to Orbit's real agent surfaces (local FastAPI backend + repo), since Orbit is a desktop app with no public website. Shipped: repo-root `llms.txt` briefing (states the never-autonomous-trading safety policy, module map, conid convention, runtime interface URLs); enriched FastAPI metadata (markdown `description`, `summary`, `contact`, `license_info`, `agent` tag) so `/openapi.json` and `/docs` are agent-comprehensible; a new `GET /.well-known/agent.json` capability + safety manifest (`backend/routers/agent.py`) derived from the live app object so it can't drift. Guard test `backend/tests/test_agent_manifest.py` protects the `autonomous_trading: false` promise. **Read-only MCP server (IMPLEMENTED on `feature/agent-readiness`, awaiting merge approval):** `fastmcp 3.4.2`, `FastMCP.from_fastapi` mounted in-process at `/mcp-server/mcp` (streamable-http), lifespan merged with the existing 8-singleton lifespan via `combine_lifespans`. Exposes decision-support reads only via a positive GET allowlist + catch-all EXCLUDE; `backend/tests/test_mcp_readonly.py` is the enforced safety boundary (empirically verified in 3.4.2: 29 non-sensitive read tools, +14 sensitive when `MCP_EXPOSE_PORTFOLIO` on — owner chose **default ON**; zero order/auth/gateway/settings/ai/mutation tools). Loopback-only trust boundary. fastmcp telemetry is OpenTelemetry-only (no default phone-home → local-first OK). Full-MCP-with-orders rejected (rule #1). `backend/mcp_server.py`; PyInstaller bundling via `collect_all` in `parallax-backend.spec` (full bundled-binary run is the build-gate step). Design: `docs/superpowers/specs/2026-06-26-mcp-readonly-server-design.md`; plan: `docs/superpowers/plans/2026-06-26-mcp-readonly-server.md`. **Pending human verification:** live MCP client list+call against a running app + authenticated gateway; the packaged-binary build. Docs+discovery slice design: `docs/superpowers/specs/2026-06-26-agent-readiness-design.md`.
- **Multi-agent GitHub workflow (in progress, branch `fix/agent-workflow-board-and-parity`):** The issue/Projects board automation is being made to work A-to-Z for opencode, Claude, and Codex. Fixed: `project-automation.yml` failed at startup on every push (`projects:` is not a valid permission scope) and used `GITHUB_TOKEN` (cannot write user Projects V2) — now drops the bad scope and uses `PROJECT_PAT`. Building: a shared `.github/actions/board-sync` composite action (board column + label moves via `PROJECT_PAT`) consumed by all three agent runners; `opencode.yml` migrated to it; new `claude.yml` (`anthropics/claude-code-action@v1`, trigger `@claude`/`/claude`) and `codex.yml` (`openai/codex-action@v1`, trigger `/codex`, which needs explicit git+`gh pr create` steps because the action only edits files). Human gates: add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` repo secrets, then run the live A-to-Z smoke test (issues #33/#34). Agent docs: `docs/agent-workflow.md`, `AGENTS.md`.

## Parallax v1 Shipped Checklist (2026-06-01)

Parallax v1 has shipped. This checklist is retained as historical release
context and as a manual regression checklist when touching shipped Parallax
flows.

| Area | Status | Required before v1 done |
|---|---|---|
| Today cockpit + triggers | CODE COMPLETE | Run one live trigger flow: rule fires, card appears, snooze removes card for the expected period, dismiss removes card, timeline remains readable. |
| Rule creation UX | CODE COMPLETE | Verify stock and watchlist rules from Today and Analysis. EMA/VWAP rows should show `Auto`, not a numeric threshold. |
| Fib chart-tied trigger | CODE COMPLETE | On Analysis, enable fib, click `Create alert`, confirm the created rule uses current chart conid/timeframe and price-range conditions for the visible golden pocket. |
| Compare mode | POLISH OPEN | Add customizable stock/reference line colors. Current hardcoded stock white is weak in light mode. |
| Indicator/chart accuracy | E2E OPEN | Cross-check RSI, EMA 9/21/50/200, VWAP, Bollinger, volume, and fib levels vs TradingView on 5 liquid symbols across 15m/1D/1W. |
| Scanner/triggers live data | E2E OPEN | Validate scanner cadence, dedup, all 4 news-candle methods, watchlist move, and auto-return with IBKR watchlists. |
| Settings + restart | E2E OPEN | Restart the app and verify theme, scan interval, model selection, watchlists, rules, locked fibs, drawings, and compare panes persist as intended. |
| Fresh install | E2E OPEN | Clean macOS run-through and Windows run-through: gateway setup, auth, first chart, first scan, first trigger, first order preview. |
| Build/typecheck baseline | CODE COMPLETE | `npm run build` passes on local `dev`. Current release caveat is Vite bundle-size / mixed static-dynamic import warnings, not TypeScript failure. |

**v2 items intentionally not required for Parallax v1:**

- Fib learning algorithm and price-outcome grading.
- Dedicated news-candle fib anchor selection.
- Cross-indicator confluence engine beyond current prompt facts.
- Optional cloud LLM providers and hybrid local/cloud inference.
- TWS-gated execution assistant / tiered scale-out workflow.
- System tray scanner.
- Inflect journal linkage.

---

## Orbit Consolidation Progress (2026-05-28)

This section tracks the newer Orbit work that renamed the former IBKR Hub concept and started combining Parallax + MoonMarket into one desktop product.

| Plan | Status | Current implementation notes |
|---|---|---|
| Plan #1 — Orbit foundation | DONE on `dev` | One React/Tauri app shell, route groups for `/parallax/*` and `/moonmarket/*`, Orbit launcher at `/`, shared FastAPI sidecar. Key commit: `4e55bf3`. |
| Plan #2 — Auth + launcher polish | DONE on `dev` | Combined single-screen Orbit launcher with gateway/connect surface, hero tiles, top-bar polish, disabled modules while unauthenticated, Inflect visible as future module. Key commits: `f8be5f7`, `6e2e0a4`, `75bc72b`; docs: `025e416`, `77e0c98`. |
| Plan #3 — MoonMarket Portfolio | DONE on `dev` | Re-stacked MoonMarket portfolio using the Orbit visual system. Left chart area keeps graph switching, right side keeps `PerformanceCards`, bottom duplicate holdings table replaced by selected-position inspector, `HistoricalDataCard` dropped. Key commit: `d88609b`. |
| Plan #4 — MoonMarket Transactions | DONE on `dev` | Transactions ledger, transaction charts, live orders tab, and shared account selector integration. Key commit: `18c8f61`. |
| Plan #5 — OrderTicket + conid nav bridge | DONE on `dev` | Paper-only MoonMarket order API, shared account store, shared right-side `OrderTicket`, stock single/bracket orders, live-order cancel/modify actions, MoonMarket↔Parallax conid navigation, Parallax trade entry. Key commits: `102826e`, `b5f06cd`, `ed4115f`, `19aa10b`, `2e994e5`, `4cd45c2`, `42bc9d5`, `90952cc`, `db76757`. |
| Plan #6 — MoonMarket Options Chain | DONE on local `dev` | Adds `/moonmarket/options/*` backend read API, option-chain client/types/hooks, MoonMarket Options route/tab, lazy per-strike call/put loading, Parallax and Portfolio options entry points, and shared OrderTicket option metadata. Single-leg option orders only; option brackets are blocked server-side and hidden in the UI. Needs IBKR paper-account smoke testing. Key commits: `4e90495`, `6841e68`, `1a923eb`, `e256554`, `782184f`, `b589364`, `7fd8c0a`, plus option-contract surface fixes in `4729648`. |
| Plan #7 — OrderTicket trailing/RTH/R-R/cash sizing | DONE on local `dev` | Adds IBKR-native `TRAIL`/`TRAILLMT`, trailing amount/type validation, outside-RTH, plain-English labels, risk/reward readout, cash sizing, percent-of-buying-power sizing via `/moonmarket/accounts/{account_id}/funds`, and IBKR-aligned modify hydration for trailing live orders. Key commits: `dbad056` through `33a05d4`. |
| Architecture follow-up — Orbit module entry seam | DONE on `feature/orbit-module-entry-seam` | Direct `/parallax`, `/moonmarket`, and `/inflect` routes now cross one shared Orbit auth-entry seam and stay on their URLs with a locked connect state when unauthenticated. `OrbitLauncher` reads the shared module registry for tile labels, descriptions, icons, and paths. Spec: `docs/superpowers/specs/2026-06-06-orbit-module-entry-seam-design.md`. Verified with focused Orbit route/launcher tests plus `tsc --noEmit`. |
| Architecture follow-up — Instrument Identity module | CODE COMPLETE on `feature/instrument-identity-module` | Quote, search, `/market/conid/{symbol}`, watchlist instrument writes, `/instruments/{conid}` reads, and Inflect cached-symbol fallback now route through `InstrumentIdentityService`; `useInstrument()` consumes the unchanged API shape. Spec: `docs/superpowers/specs/2026-06-06-instrument-identity-module-design.md`. Verified with focused backend identity/watchlist/Inflect/conid-cache tests, hook test, and `tsc --noEmit`. |
| - **Architecture follow-up — Sidecar client contracts by module:** DONE on `dev` via PR #29. Frontend sidecar access is now split by ownership: shared transport/runtime lives in `src/lib/sidecarClient.ts`, Orbit shell/gateway/auth endpoints remain in the slim `src/lib/api.ts`, and product contracts live in `src/modules/moonmarket/api.ts`, `src/modules/inflect/api.ts`, and `src/modules/parallax/api.ts`. Added direct sidecar runtime tests and moved MoonMarket endpoint contract tests into the MoonMarket module. Spec: `docs/superpowers/specs/2026-06-07-sidecar-client-contracts-design.md`.
| - **v1 foundation review fixes (2026-06-10):** DONE on `dev` via `fix/v1-foundation-review-fixes`. Parallel-agent code review of the 7 foundation findings surfaced 8 issues, all fixed: trading safety now fails closed on unknown accounts (404 instead of silent `paper_allowed`), `TradingSafetyDecision` enforces mode/allowed/confirmation consistency, OrderTicket's live gate blocks (never falls back to invented copy) when the safety service is unreachable/rejecting/incomplete, `ApiError` re-exported from `@/lib/api`, and Inflect positions read through a new `InflectExecutionAdapter` on the Client Portal execution adapter. Backend 1143 green; frontend baseline unchanged.

**Next Orbit work after current local `dev`:**

- Manual IBKR paper validation for options chain data, single-leg option preview/place, and enhanced stock order-ticket flows.
- Option bracket order design/implementation after single-leg validation.
- Remaining Orbit polish pass: shared settings, visual consistency, build/distribution checks, and any unmerged roadmap cleanup.

## Order Placement Status + Test Plan (2026-06-03)

Current mutations use the shared Trading Safety policy. Paper actions are
allowed directly; live actions require policy-backed real-money confirmation
and fail closed when account or policy state is unavailable.

| Capability | Status | Notes |
|---|---|---|
| Stock order preview | DONE | `/moonmarket/orders/preview` calls IBKR `whatif`. Allowed on paper and live accounts because it does not mutate. |
| Stock single order placement | DONE | Paper is allowed directly; live requires policy-backed real-money confirmation. |
| Stock bracket orders | DONE | Entry + profit-taker + stop payload is preserved as an IBKR order group; live submission uses the same confirmation gate. |
| Reply/confirm order | DONE | IBKR warning/reply flows use Trading Safety; live replies require confirmation. |
| Cancel live order | DONE | Available from MoonMarket live orders; live cancellation requires confirmation. |
| Modify live order | DONE | Opens the shared ticket with existing order context; live modification requires confirmation. |
| Trailing stop / trailing stop limit | DONE | Supports `TRAIL` and `TRAILLMT`. Trailing orders reject `IOC`; `TRAILLMT` requires both `price` and `auxPrice` per IBKR order payload rules. |
| Outside RTH | DONE | Optional flag on the shared order draft and IBKR payload. Defaults off. |
| Cash / buying-power sizing | DONE | Frontend computes share quantity from entered cash or percent of IBKR buying power. IBKR still receives `quantity`. |
| Risk/reward readout | DONE | Informational only; never blocks placement. Shown when bracket TP/SL inputs and an entry reference are available. |
| Option single-leg order | CODE COMPLETE | Implemented with Plan #6 and merged to local `dev`; needs IBKR paper-account smoke test. |
| Option bracket order | DEFERRED | Explicitly rejected server-side until single-leg option orders are validated. |
| Live-account mutations | DONE | Allowed only through `TradingSafetyPolicy`, explicit frontend real-money confirmation, and backend policy reevaluation. Unknown or incomplete state fails closed. |

Manual order-placement smoke test:

1. Use an IBKR paper account (`DU...`).
2. Open Parallax Analysis for a liquid stock, click `Trade`.
3. Preview a small market order; verify IBKR returns margin/cost preview.
4. Preview a small limit order away from market; verify preview response and displayed price.
5. Place a tiny paper order; handle any IBKR reply prompt through the confirm flow.
6. Confirm the order appears in MoonMarket Transactions / live orders.
7. Modify the order price from the live-orders row.
8. Cancel the order from the live-orders row.
9. Repeat with a bracket order: entry, profit target, stop. Verify all child payload fields are present and the R/R readout matches the entered prices.
10. Preview/place a tiny `TRAIL` order in paper with `DAY` or `GTC`.
11. Preview/place a tiny `TRAILLMT` order in paper with trail amount/type, limit offset, and aux price.
12. Test cash sizing and percent-of-buying-power sizing against a known buying-power response.
13. Switch to a live account and verify place/reply/cancel/modify require the policy-provided real-money confirmation and send nothing before confirmation.
14. Repeat preview/place for one liquid single-leg option contract in paper only.

---

## Task Breakdown

### Legend
- `[Ben]` / `[Ofek]` — assigned to
- `[Both]` — pair or either
- `[?]` — needs investigation before starting

---

### Phase 1: Foundation (Backend Core) — COMPLETE

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 1.1 | FastAPI app skeleton | Ben | DONE | main.py, CORS, lifespan, typed exception handlers, /health |
| 1.2 | IBKR auth service | Ben | DONE | Singleton with retry, typed exceptions, background tickle loop |
| 1.3 | Rate limiter + cache layer | Ben | DONE | aiolimiter token-bucket, in-memory TTL cache (replaced Redis) |
| 1.4 | SQLite schema + service | Ofek | DONE | 3 tables + instruments table (conid PK), WAL mode, full CRUD |
| 1.5 | Market data router | Ben | DONE | /market/quote, /candles, /search, /conid — TradingView format |
| 1.6 | WebSocket handler | Ben | DONE | Two-layer: FastAPI /ws for frontend, IBKR ws with auto-reconnect |
| 1.7 | Pydantic models | Ofek | DONE | Full model set for all routes |
| 1.8 | Indicator computation service | Ofek | DONE | All 14 indicators, Polars→Pandas bridge for pandas-ta |
| 1.9 | Indicator router | Ofek | DONE | POST /indicators/compute — returns candles + all indicators + fib |

---

### Phase 2: Foundation (Frontend Core) — COMPLETE

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 2.1 | App shell + routing | Ofek | DONE | Zustand tab-based routing, pill nav, connection status dot |
| 2.2 | Zustand stores | Ofek | DONE | 5 stores: navigation, chart, watchlist, screener, settings |
| 2.3 | TanStack Query + API client | Ben | DONE | Typed API client, QueryClient with desktop-optimized settings |
| 2.4 | WebSocket hook | Ben | DONE | Auto-reconnect, exponential backoff, handler registration |
| 2.5 | Theme + design tokens | Ofek | DONE | Dark cinematic theme, trading colors with glow, Inter + JetBrains Mono |
| 2.6 | shadcn/ui components | Ofek | DONE | 11 components installed, styled by dark theme |
| 2.7 | Tauri sidecar auto-launch | Ben | DONE | shell + process plugins, polls /health, dev mode skips spawn |

---

### Phase 3: Dashboard — COMPLETE

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 3.1 | Market Pulse bar | Ofek | DONE | SPX/VIX/QQQ/DIA/IWM/TLT/GLD/USO with sparklines |
| 3.2 | Arc gauges | Ofek | DONE | Market Strength, VIX, Rotation, Triggers — SVG with glow |
| 3.3 | Sector Performance panel | Ben | DONE | Sorted bidirectional bars, GET /sectors/performance |
| 3.4 | Sector Rotation RRG | Ben | DONE | Standard JdK method, 5-point trails, GET /sectors/rrg |
| 3.5 | Master Watchlist sidebar | Ben | DONE | IBKR fetch-only, multi-watchlist dropdown, live quotes |
| 3.6 | Dynamic trigger watchlists | Ofek | DONE | Trigger hits with colored glow edges by indicator type |
| 3.7 | Trigger Rules section | Ofek | DONE | Compact list + create modal, full CRUD backend |
| 3.8 | Click stock → Analysis | Both | DONE | navigateToAnalysis(conid) wired throughout |

---

### Phase 4: Technical Analysis Screen

> Goal: Full chart with indicators, Fibonacci, and AI panel.

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 4.1 | Chart wrapper (Lightweight Charts) | Ben | DONE | Candlestick + volume, timeframe switcher, live WS updates |
| 4.2 | Indicator overlay system | Ben | DONE | EMA, Bollinger, VWAP as line overlays |
| 4.3 | Sub-chart panels (RSI, MACD, etc.) | Ben | DONE | Stacked instances, ResizeObserver, show/hide via pills |
| 4.4 | Fibonacci retracement overlay | Ofek | DONE | Auto swing high/low detection algorithm |
| 4.5 | Fibonacci manual adjustment | Ofek | DONE | 
| 4.6 | Indicator pill toggles | Ofek | DONE | Per-indicator colors, glow states, wired to chart store |
| 4.7 | AI config panel | Ofek | DONE | Timeframe/indicator multi-select, AI Assist/Manual toggle |
| 4.8 | Action Signal card | Ofek | DONE | Direction badge, confidence, entry/stop/target, checklist |
| 4.9 | AI chat interface | Ben | DONE | Message list + input, scrollable, streaming responses |
| 4.10 | Ollama integration service | Ben | DONE | services/ai.py — structured JSON input, model per-request |
| 4.11 | AI analysis router | Ben | DONE | routers/ai.py — 8 endpoints (status, models, setup-guide, analyze, chat) |
| 4.12 | Ollama lifecycle management | Ben | DONE | services/ollama.py — detect binary, start server, list models, setup guide |
| 4.13 | Prompt builder refactor | Ben | DONE | Extracted to `services/prompt_builder.py`. Per-indicator formatter registry (no if/elif). Dynamic system prompt with per-indicator analysis hints. Token budget (3000) with graceful truncation (drops oldest timeframes first). |
| 4.14 | Watchlist context in /ai/analyze | Ben | DONE | Optional `watchlist` field on AnalyzeRequest (+ TS type). 6 watchlist archetypes matched by substring (RS leaders, short-term, swing, long-term, momentum, mean reversion). Unknown watchlists get generic framing mentioning the name. Wired through router → ai.analyze → build_system_prompt. |

---

### Phase 5: Screener

> Goal: Filter instruments via IBKR native scanner filters, display paginated results, AI-assisted filter creation.
> Universe source: IBKR Scanner API presets (top gainers, most active, etc.).
> Scan mode: On-demand only (user clicks Scan). Background scan is Phase 6.

#### 5A — Core — DONE

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 5.1 | Screener filter bar | Ofek | DONE | IBKR native filter codes, grouped dropdown (Fundamental/Technical/Analyst/Short Interest) |
| 5.2 | Screener results table | Ofek | DONE | Symbol, Name, Type, Price, Chg%, Volume, Mkt Cap; sortable |
| 5.3 | Screener backend service | Ben | DONE | scanner_run with native filters + batch snapshots; no indicator computation |
| 5.4 | Screener router | Ben | DONE | POST /screener/scan, GET /screener/presets |
| 5.5 | Click result → Analysis | Both | DONE | navigateToAnalysis(conid) on row click |
| 5.6 | Universe via IBKR Scanner API | Ben | DONE | /iserver/scanner/params + /iserver/scanner/run |

#### 5B — Enhancements — DONE

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 5.7 | Quick-peek slide-over | Both | DONE | 400px right panel, contract info endpoint, 52W range bar, "Open in Analysis" + "Add to Watchlist" |
| 5.8 | Skeleton loaders | Ofek | DONE | Shimmer table rows during scan, slide-over skeleton, preset dropdown skeleton |
| 5.9 | Persist last scan | Ben | DONE | Zustand store is module-scoped — results survive page navigation without persist middleware |
| 5.10 | Pagination + uncap results | Ben | DONE | Backend paginates server-side up to 200 from IBKR. Frontend page controls (25/50/100/page) |
| 5.11 | Scanner sort codes | Ben | DONE | IBKR server-side sort via `sort` param. Frontend sort dropdown + direction toggle in filter bar |
| 5.12 | WSH earnings date preset | Ben | DONE | "Earnings This Week" preset with `wshEarningsDate` default filter. Added to Fundamental category |

#### 5C — AI-Assisted Filters — DONE

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 5.13 | AI screener side panel (UI) | Ofek | DONE | Collapsible right panel. Freeform text input + preset quick-question chips. Shows reasoning per filter. |
| 5.14 | AI screener backend endpoint | Ben | DONE | POST `/screener/ai-filters` — query + filter catalogue → Ollama → `{filters: [{code, value, reasoning}]}` |
| 5.15 | AI → filter bar wiring | Both | DONE | AI response auto-populates filter bar pills. User tweaks/removes before scan. |
| 5.16 | Prompt engineering | Ben | DONE | System prompt with IBKR filter catalogue, output schema, edge case handling (ambiguous/conflicting/unknown filters) |

---

### Phase 6: Background Scanner + Triggers — COMPLETE

> Goal: Periodic scans, trigger detection, IBKR watchlist moves, desktop notifications.
> Watchlist strategy: Real IBKR watchlist manipulation (read → modify → overwrite via Client Portal API). Stocks move between IBKR watchlists so they show in TWS/mobile too.
> News candle strategy: Ship all 4 detection methods as selectable options. User picks per-rule. Evaluate which works best in practice.
> Branch: `feature/phase6-scanner-triggers` — 7 commits, pending PR to dev.

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 6.1 | Background scheduler | Ben | DONE | asyncio task in lifespan with auth-wait startup. Per-rule `scan_interval_seconds` (default 300). `next_scan_at` tracks per-rule cadence. Runs while app is open only. |
| 6.2 | Trigger evaluation engine | Ben | DONE | Groups rules by conid → batch indicator compute → evaluates conditions (above/below/crosses_above/crosses_below/fires). `dedup_key` prevents double-fires within the interval window. |
| 6.3 | IBKR watchlist moves | Ben | DONE | `move_between_watchlists`: fetch source list → remove conid → overwrite; fetch target list → append conid → overwrite. Uses ibind `create_watchlist`. |
| 6.4 | Trigger hit persistence + dedup | Ofek | DONE | SQLite `trigger_hits` table with `dedup_key` (rule_id + date + interval). `record_trigger_hit` upserts on conflict. `mark_moved_back` flips the bit on successful return. |
| 6.5 | Desktop notifications + WS alerts | Ofek | DONE | Tauri notification plugin fires on trigger hit. Backend WS broadcasts `trigger_alert` event to all frontend clients. Frontend WebSocket hook dispatches to `AlertLog` via TanStack Query `invalidateQueries`. |
| 6.6 | News candle trigger | Both | DONE | 4 methods: `volume_spike` (× 20-bar avg vol), `range_spike` (× 20-bar avg range), `gap` (% vs prev close), `long_wick` (max wick ÷ body). User selects method per rule. `news_candle_method` stored in `trigger_rules`. Frontend `CreateRuleModal` switches to method selector when `indicator = news_candle`. |
| 6.7 | Alert log dashboard panel | Ofek | DONE | 160px bottom panel, full-width. 5-col grid: Time / Symbol / Rule / Condition→Actual / Source→Target. Indicator colour-coded dots. Click row → `navigateToAnalysis(conid)` + auto-dismiss toast. WS `trigger_alert` live-refreshes via TanStack Query. `get_trigger_hits` LEFT JOINs `trigger_rules` to surface `rule_name`. |
| 6.8 | Auto-expire return scanner + watchlist config UI | Ofek | DONE | `watchlist_config` SQLite table: per-watchlist `auto_expire_days` override. Override priority: config row (even NULL = no-expire) beats rule value. `_return_expired_hits()` runs each scanner heartbeat: moves symbol back to source on expiry, only marks `moved_back=1` on IBKR success (retries on failure). Frontend: collapsible "Watchlist Expiry" section in sidebar, IBKR watchlist dropdown, inline day editing. 19 backend tests + 3 trigger-hit tests. |

---

### Phase 7: Polish + Integration — COMPLETE

> Goal: Everything works together, feels professional.

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 7.1 | IBKR disconnect detection + re-auth | Both | DONE | Non-blocking banner + Reconnect CTA; `IBKRAuthError` / `IBKRSessionExpiredError`; retries with backoff |
| 7.2 | Error states + toast system | Both | DONE | Skeleton loaders, error boundaries per panel, Sonner toasts for transient errors |
| 7.3 | Settings page + theme fixes | Both | DONE | Scan interval, default timeframe, Ollama model selector, IBKR gateway URL — SQLite-persisted |
| 7.4 | Performance optimization | Both | DONE | 7.4a: query dedup + `useIbkrReadyTier` stagger hook. 7.4b: React.lazy() code splitting for AnalysisPage + ScreenerPage. 7.4c: `@tanstack/react-virtual` for WatchlistSidebar |
| 7.5 | Health status strip + diagnostics | Both | DONE | 🟢/🟡/🔴 strip in shell. Modal: IBKR Gateway, Ollama, Scanner, Database, Background Triggers — plain-English status. "Copy diagnostics" → minimal JSON to clipboard only. No log viewer |
| 7.6 | Empty states | Both | DONE | Shared `<EmptyState>` component. Covers: empty watchlist, chart no symbol, scanner pre-run + zero results, empty trigger list, AI chat no history (prompt chips), empty alert log |
| 7.7 | Release packaging | Both | DONE | PyInstaller `--onefile` sidecar (run.py entry point). `scripts/build-backend.sh` + `.ps1` for local builds. macOS universal .dmg via GitHub Actions lipo (arm64 on macos-14 + x86_64 on macos-13). Windows NSIS + MSI on windows-latest. `.github/workflows/release.yml` — push `v*.*.*` tag → CI builds + draft GitHub Release. No code signing (no paid certs). CORS updated for `tauri://localhost`. `src-tauri/binaries/` gitignored. |

---

### Phase 8: End-to-End Testing — HISTORICAL V1 CHECKLIST

> Goal: Verified correct behaviour across all critical flows with a live IBKR connection. Retained as historical v1 release context and a future regression checklist.

| # | Task | Owner | Status | Notes |
|---|---|---|---|---|
| 8.1 | IBKR connection lifecycle | Both | DONE* | Cold start, gateway down, session expiry, re-auth banner, reconnect success. *Code-complete incl. 8.1-F (client `navigator.onLine` fast-fail + singleton offline toast + auto-refetch on recovery, 2026-04-17). Still under ongoing manual verification — we re-exercise the login loop every session, so rows A–F stay "live" rather than locked. Brother continues E2E on his machine. |
| 8.2 | Ollama detection walkthrough | Both | TODO | Not installed, installed but no model, model switch mid-session, Ollama crash recovery |
| 8.3 | Scanner flow | Both | DONE | Branch `fix/scanner` merged via PR #22. Canonical IBKR filter catalogue + `/filter-catalogue` endpoint. Dynamic frontend filter bar driven off the catalogue. Preset grouping with 8 niche screens + curated 27 (Path B) + Browse-all panel (Path C) + location reset banner. AI screener: per-caller think mode, truncation/empty/markdown guards, dedupe, filters preserved on scanner change. Snapshot data-gap fixes (require 7289, two-pass retry, contract_info mc fallback, drop ticker-only rows; parallelized; mc requirement dropped + column removed). NumericFilterInput w/ thousands separators, pagination polish, IBKR `EMPTY 500` handling, baseline filters, pre-market subtitle, amber Scan CTA, S&P 500 card lock, peek panel enrichment, client-side sort + cumulative buffer + dirty indicator. Test top-up commits 5d51d13 + 980f035. |
| 8.4 | Trigger firing | Both | TODO | All 4 news candle methods under live data; watchlist move + return; dedup across intervals |
| 8.5 | Chart + indicator accuracy | Both | TODO | Cross-check indicator values vs TradingView on 5 symbols across 3 timeframes |
| 8.6 | Settings persistence | Both | TODO | All settings survive app restart; theme applies on cold launch |
| 8.7 | Error + empty state coverage | Both | TODO | Force each error condition manually; verify correct state renders, no blank screens |
| 8.8 | Fresh-install run-through | Both | TODO | Clean macOS VM + clean Windows VM; gateway setup → first symbol → first trigger |
| 8.9 | Dashboard bugs + request issues | Both | DONE | Merged via PR #21. Shipped: watchlist 500 fix, 9-tier staggered loads (250 ms cascade — later collapsed to 4 tiers in Phase 9 / 3.4), per-component pulse skeletons, Market Pulls rewrite (13 tickers centred, 80 ms inner stagger, sparklines), WS singleton with 10 s teardown grace, real Market Strength + Sector Rotation arc gauges (ETF proxy / 21-day offensive-vs-defensive), VIX click → Analysis(1D), Sector Performance scrollable (3 visible + fade hint), RRG flex-1 min-h 280 px with percentage-based SVG, AlertLog collapse-when-empty + dashboard-scroll-when-populated. 17 new backend tests (9 unwrap + 8 gauges) + 12 tier-hook tests, all green. See [`docs/phase8-task8.9-plan.md`](docs/phase8-task8.9-plan.md). |
| 8.10 | Gateway lifecycle UX (orphan recovery + 3-level recovery + UI states + cache/toast feedback) | Both | DONE | Merged via PR #23. Backend: PID file at `~/.parallax/gateway/gateway.pid` written on spawn / cleared on stop; `_recover_existing_process()` adopts orphans whose `psutil` cmdline contains our gateway home (refuses Docker / unrelated PIDs); fallback `process_iter` scan when pid file is missing/stale; `gw.logout()` posts to `/v1/api/logout` mapped to `POST /gateway/logout`; `run.py` converts `SIGHUP → SIGTERM` so terminal-close runs lifespan. Frontend: 3-level recovery — `Logout` / `Restart Gateway` / `Factory Reset` (Settings only); in-button spinners; `useGateway` does optimistic state flips. **Logout / Restart / Factory Reset emit Sonner success+error toasts and invalidate every IBKR-session-dependent query via a `predicate` filter.** Dev: `scripts/dev-backend.sh` + `.ps1` trap signals + kill stale pid before exec-ing uvicorn. New dep: `psutil>=6.0.0`. |

---

### Phase 9: Dashboard Request-Fan-Out Optimization — COMPLETE (code) · UNVERIFIED (metrics)

> Goal: Cut the 39-call dashboard mount + 60s cold-start time down to <5s by aligning the IBKR call protocol (pre-flight, secdef-warm, accounts bootstrap), bundling endpoints, coalescing concurrent calls, caching where stable, and modernizing frontend polling.
> Source plan: [`docs/phase8-dashboard-optimization-plan.md`](docs/phase8-dashboard-optimization-plan.md) (named "Phase 8" in its own file but tracked here as Phase 9 to disambiguate from E2E testing).
> Triggered by: HAR + backend-log analysis after 8.9 — 85 quote calls, 27 gateway-status calls, ~250 IBKR snapshots in a 170s window.

**Sub-phase 1 — IBKR service core**

| # | Task | Branch | Status | Commit |
|---|---|---|---|---|
| 9.1.1 | Externalize pacing table to `backend/constants/ibkr_pacing.py` | `feat/ibkr-pacing-constants` | DONE | `d9678f5` |
| 9.1.2 | `/iserver/accounts` cold-start bootstrap | `feat/ibkr-accounts-bootstrap` | DONE | `a647c30` (+ empty-list retry hotfix `c753547`) |
| 9.1.3 | Snapshot pre-flight + warmed-conid set (750ms delay, per-conid lock) | `feat/ibkr-snapshot-preflight` | DONE | `da652cb` |
| 9.1.4 | `/iserver/secdef/search` pre-warm for non-STK contracts | `feat/ibkr-secdef-prewarm` | DONE | `57e7e40` |
| 9.1.5 | Server-side conid SQLite cache (forever-TTL, `force_refresh` kwarg) | `feat/conid-cache-sqlite` | DONE | `f89ab73` (+ SQLITE_MISUSE write-lock hotfix `c753547`) |
| 9.1.6 | Snapshot/history request coalescing via in-flight future map | `feat/snapshot-coalescing` | DONE | `726db8d` |
| 9.1.7 | Auth-state TTL cache (5s default, replaces `_auth_probe_lock`) | `feat/auth-state-cache` | DONE | `fd8852c` |

**Sub-phase 2 — Backend routers**

| # | Task | Branch | Status | Commit |
|---|---|---|---|---|
| 9.2.1 | Bundled `GET /market/quotes?conids=...` (50-conid chunks) | `feat/bundled-quotes-endpoint` | DONE | `2860f8b` |
| 9.2.2 | Bundled `GET /market/candles?conids=...` (5-concurrent semaphore) | `feat/bundled-candles-endpoint` | DONE | `a856f7d` |
| 9.2.3 | `/sectors/*` 60s server cache | `feat/sectors-cache` | DONE | `fe1ba30` |
| 9.2.4 | `/health/details` strict-superset of `/gateway/status` (shape unify) | `feat/health-status-unify` | DONE | `294cc39` |
| 9.2.5 | WebSocket auth-state push (subscribe to IBKR `sts` topic) | `feat/ws-auth-state-push` | DONE | `d053055` |

**Sub-phase 3 — Frontend hygiene**

| # | Task | Branch | Status | Commit |
|---|---|---|---|---|
| 9.3.1 | MarketPulse uses bundled quotes + candles endpoints | `feat/pulse-bundled-quotes` | DONE | `49c598a` |
| 9.3.2 | Validate cached conid resolution (no code change — manual HAR check) | `feat/pulse-cached-conids` | DONE | (covered by 9.1.5) |
| 9.3.3 | Defer pulse candles until quotes settle | `feat/defer-pulse-candles` | DONE | `9ef8f11` |
| 9.3.4 | Tier reduction (9 → 4 tiers, 800ms total stagger) | `feat/dashboard-4-tiers` | DONE | `5ee0afe` |
| 9.3.5 | `staleTime` / `refetchInterval` audit across all queries | `chore/query-timing-audit` | DONE | `fd991ec` |
| 9.3.6 | `/gateway/status` retry burst fix (3×500ms → 1×1500ms) | `fix/gateway-status-retry` | DONE | `e00a945` |
| 9.3.7 | Pre/post-login cadences + visibility-aware polling + WS auth subscription | `feat/auth-polling-modernized` | DONE | `0d650e9` |

**Sub-phase 4 — Observability + docs**

| # | Task | Branch | Status | Commit |
|---|---|---|---|---|
| 9.4.1 | Cold-start protocol docs + `docs/ibkr-pacing.md` | `docs/ibkr-cold-start-protocol` | DONE | `f4d3ef5` |
| 9.4.2 | Gate `RequestLoggingMiddleware` behind `PARALLAX_REQUEST_LOG` env var | `chore/request-logging-toggle` | DONE | `5be2e30` |
| 9.4.3 | `summarize_request_log.py` Polars acceptance-dashboard script | `chore/log-summary-tool` | DONE | `d689e99` |

**Cross-cutting invariants introduced (must be respected by future work):**

- `DatabaseService` write-lock (Task 9.1.5 hotfix) — every SQLite-write method dispatches through `self._run_write(fn)`, never `asyncio.to_thread(fn)` directly. Reads bypass the lock (WAL mode serialises read-vs-write at the file level).
- Pacing values live in `backend/constants/ibkr_pacing.py` only — no hardcoded RPS literals elsewhere.
- `conid` is the universal instrument key — caches key by `(symbol, sec_type)` only at the resolver boundary; everything downstream of `get_conid()` is keyed by `conid`.

**Outstanding for Phase 9 — empirical verification (not yet run):**

Per the plan's target table (`docs/phase8-dashboard-optimization-plan.md` line 786), confirm post-optimization metrics on a fresh 170s post-login dashboard run:

| Metric | Before | Target | Verified? |
|---|---|---|---|
| `/market/quote/:id` count | 85 | <5 | ⏳ |
| `/market/candles/:id` count | 20 | <5 | ⏳ |
| `/gateway/status` count | 27 | <5 | ⏳ |
| Backend → IBKR snapshot calls | ~250 | <60 | ⏳ |
| `Snapshot timed out` warnings | many | 0 | ⏳ |
| Dashboard time-to-fully-rendered | ~60s cold | <5s cold / <1s warm | ⏳ |

Run `uv run python backend/scripts/summarize_request_log.py` after a 170s post-login session and record the numbers back into the optimization plan's status table.

---

### Phase 10: Compare Mode + WebSocket Reliability — COMPLETE

> Goal: Add a dedicated Compare Mode to the Analysis page (per-stock vs. relative-ticker analysis, inspired by @ultrawavetrader's clean-chart methodology) and harden the live-data path against the cold-boot / late-auth / cold-conid scenarios that surfaced once the feature went live.
> Source spec: [`docs/superpowers/specs/2026-05-18-compare-mode-design.md`](docs/superpowers/specs/2026-05-18-compare-mode-design.md)
> Source plan: [`docs/superpowers/plans/2026-05-18-compare-mode-plan.md`](docs/superpowers/plans/2026-05-18-compare-mode-plan.md)
> Merged: dev @ commit `69928d8` (29 commits total).

**Sub-phase 1 — Compare Mode feature (frontend)**

The Compare button on the Analysis toolbar replaces the chart area with a stack of 1–3 dual-axis panes. Each pane shows the primary stock vs. an independent reference symbol on two price scales, both Mode.Normal ("Regular"). LineSeries (not candlesticks) for the cleanest Indi-style read. Per-pane reference input, per-pane timeframe, per-pane layout (overlay / stockOnly / refOnly).

| # | Task | Status | Commit |
|---|---|---|---|
| 10.1.1 | Compare Zustand store (active flag, panes list, per-pane reference, persist middleware) | DONE | `16af035`, `8ad8ca1`, `c8a62e1` |
| 10.1.2 | `useCompareData` hook — per-pane data + live ticks | DONE | `b323391` |
| 10.1.3 | `CompareChart` component — dual-axis LineSeries with crosshair sync | DONE | `75022a5`, `c1f6169` |
| 10.1.4 | `PaneToolbar` + `ComparePane` + `CompareView` + `CompareModeHeader` | DONE | `6f26352`, `f460a4a`, `888196f`, `c176891` |
| 10.1.5 | Wire into AnalysisPage (Compare toggle button, `C` shortcut, conditional render, AI panel auto-collapse, watchlist-click force-exit) | DONE | `db6b944`, `41c1821` |
| 10.1.6 | Per-pane reference symbol (each pane can compare against a different ticker) + persist migration v1→v2 | DONE | `c8a62e1` |
| 10.1.7 | UX polish — default 15m, floating Reset Zoom, loading skeleton, layout-change black-chart fix | DONE | `22183a1`, `eaf2041` |
| 10.1.8 | Marker tool (vertical divergence markers) — added then reverted; click-position math couldn't be pinned down to user satisfaction | REVERTED | `19f1ba4` → `7c46fcf` |

**Sub-phase 2 — WebSocket reliability (the path live data actually flows through)**

| # | Task | Status | Commit |
|---|---|---|---|
| 10.2.1 | Ref-count subscriptions at the frontend WS singleton (multiple consumers per conid don't fight) | DONE | `5a56d5b`, `b098ab8` |
| 10.2.2 | Queue subscribes when IBKR WS isn't connected yet; flush on connect | DONE | `277297a` |
| 10.2.3 | 10-minute subscription refresh task (IBKR auto-terminates streams at 15 min per their docs) + `authenticated` guard on subscribe | DONE | `f73d3e7` |
| 10.2.4 | FE→BE WS gate ported from MoonMarket, then loosened (gate was too aggressive on cold boot) — accepts FE immediately, sends `connection_status` updates as IBKR comes online | DONE | `efd93de` → `ff9b232` |
| 10.2.5 | 50ms pacing on bulk subscribe sends (flush + 10-min refresh) | DONE | `efd93de` |
| 10.2.6 | IBKR WS auto-starts on auth transition (was: only on FE-connect, which missed the typical cold-boot window) | DONE | `27806d9` |
| 10.2.7 | Subscription-hook churn fix — separate diff effect from unmount-only cleanup. Eliminated the 3–5 s "stuck" feel on dashboard → analysis nav | DONE | `69928d8` |

**Sub-phase 3 — Backend reliability (history endpoint mostly)**

| # | Task | Status | Commit |
|---|---|---|---|
| 10.3.1 | History concurrency semaphore (IBKR's documented 5-concurrent cap; we use 4) — applied to BOTH `history()` and `history_bundled()` | DONE | `6941df5`, `ff9b232` |
| 10.3.2 | Retry policy 3→4 attempts with exponential backoff `(0.5, 1, 2, 4)` seconds — 503s on cold-conid pre-warming now mostly recover transparently | DONE | `6941df5` |
| 10.3.3 | `clamp_period_to_bar()` — per-bar-size `max_period` ceiling (15m → 1m, 1h → 6m, 1D → 5y, etc.). Stops `2y@15min` 503s before they reach IBKR | DONE | `692da26` |
| 10.3.4 | Optional response-body logging behind `PARALLAX_LOG_RESPONSE_BODIES=1` for diagnostics | DONE | `6941df5` |
| 10.3.5 | SQLite read race — `_run_read()` shares the same lock as `_run_write()` to protect against concurrent shared-connection cursor corruption. Affects `get_cached_conid`, `get_setting`, trigger reads | DONE | `ff9b232`, `69928d8` |
| 10.3.6 | `est_max_bars` recalibrated to match IBKR's actual 1000-bar cap (was undercounting and firing spurious warnings) | DONE | `eaf2041` |

**Sub-phase 4 — Frontend perf / polish**

| # | Task | Status | Commit |
|---|---|---|---|
| 10.4.1 | AbortSignal threaded through `request<T>()` + 14 high-traffic api methods + 13 queryFn call sites. Route-change cancels in-flight requests | DONE | `072252a` |
| 10.4.2 | MarketPulse live data via WS (replaces 10s `quotesBundled` polling). Sparkline + `candlesBundled` query removed (noise + traffic without analytical value) | DONE | `e7afcbe` |
| 10.4.3 | `useLiveQuotes` hook — generalized "many tickers, one consumer" WS subscription pattern | DONE | `e7afcbe` |
| 10.4.4 | Default chart timeframe `1D → 15m` per user feedback (compare mode default also 15m) | DONE | `22183a1` |

**Cross-cutting invariants introduced (must be respected by future work):**

- **`DatabaseService._run_read(fn)`** — every SQLite read on the shared `sqlite3.Connection` now goes through the same lock as writes. Earlier we let reads bypass for concurrency; in practice that produced intermittent `SQLITE_MISUSE` ("bad parameter or other API misuse") under dashboard-cold-load concurrent `resolveConid` calls. SQLite reads are microsecond-fast so the lost concurrency is negligible. New read paths must use `_run_read(lambda: self._fetchone(...))`, never `asyncio.to_thread(self._fetchone, ...)` directly.

- **WS subscription hooks (`useChartData`, `useCompareData`, `useLiveQuotes`)** — diff logic (subscribe new / unsubscribe removed) and unmount cleanup MUST be in two separate `useEffect` calls. Mixing them in one effect causes the cleanup return to drain everything on every dep change, producing the subscription storm we hit in `69928d8`. Pattern:
  ```ts
  useEffect(() => { /* diff: sub adds, unsub removes */ }, [conidsKey]);
  useEffect(() => () => { /* drain on unmount */ }, []);
  ```

- **History endpoint period clamp** — every `request.history_period` override is passed through `clamp_period_to_bar(period, timeframe)` before reaching `ibkr.history()`. The backend's `TIMEFRAME_SPEC.max_period` is the source of truth; the frontend `PERIOD_LADDER` has matching ceilings in `TIMEFRAME_PERIOD_CEILING` (keep in sync).

- **`tickle()` is the sole WS-lifecycle trigger** — its success branch calls `start_ibkr_websocket()` (idempotent). Auth-transition paths (`/auth/status` flipping to True, gateway warm-up) all flow through `tickle()` eventually via `start_tickle_loop()`. Do not add another start-on-event path; extend the tickle chain instead.

- **IBKR WS concurrency cap is 4** — both `history()` and `history_bundled()` share `self._history_semaphore`. Any new IBKR endpoint that fans out parallel calls must wrap them in the same semaphore.

**Known issues / follow-up work:**

1. **58 pre-existing backend test failures** carried over from before this phase. Categories (see `tests/test_watchlist_*.py`, `test_scanner.py`, `test_fibonacci.py`, `test_chart_context.py`, `test_sectors_gauges.py`):
   - `'IBKRRequestError' object has no attribute 'detail'` — tests use `.detail`, exception class has `.message`
   - `services.ibkr does not have the attribute 'cache'` — `patch()` target removed
   - `MagicMock can't be used in 'await' expression` in scanner — tests should use `AsyncMock`
   - `_evaluate_group() takes 3 positional arguments but 4 were given` — signature drift
   - `'DatabaseService' object has no attribute 'connect'` — tests call private `_connect`
   - `'State' object has no attribute 'ibkr'` — TestClient missing `app.state.ibkr` setup
   - `Cannot send a request, as the client has been closed` (14 tests) — TestClient lifespan-shutdown closes the http client, next test in the same module reuses it. Single root-cause fixture issue.
   - Sectors gauges / chart context calibration drift — assertion values don't match current implementation
   - Most of these are test-code bugs, not production-code bugs.

2. **IBKR cold-conid 503 on first history hit** — still happens (4–6 sector ETFs on every fresh app start) but absorbed by the retry budget. Not actionable from our side.

3. **Marker feature** — reverted. Future re-attempt should probably use horizontal price-level markers rather than vertical time-markers; the time-axis click-position math against lightweight-charts was unreliable.

4. **Color customization** for compare-mode line colors — currently hardcoded white (stock) + green (reference). Settings panel addition is straightforward (`STOCK_LINE_COLOR` + `REF_LINE_COLOR` constants in `CompareChart.tsx`).

5. **Backend cancellation awareness** — TanStack Query now cancels frontend fetches on route change, but the backend doesn't read `request.is_disconnected()` so the Python side keeps doing work + retrying 503s for queries the user has already navigated away from. Worth wiring in long-running routes.

---

### Phase 11: AI Prompt Fact Layer — COMPLETE

> Goal: Replace the legacy string-format prompt builder with a structured, priority-sorted fact pipeline. Each market signal becomes a typed `PromptFact` with a bracketed ID the LLM can cite in its narrative (e.g. `[D.ema.stack_bullish]`), making the analysis traceable from raw data → fact → model conclusion. Dynamic per-model context budgeting replaces static tier table.
> Branch: `feature/ai-prompt-context-facts` — merged to dev 2026-05-25.
> Plan: [`docs/superpowers/plans/2026-05-24-ai-prompt-fact-layer.md`](docs/superpowers/plans/2026-05-24-ai-prompt-fact-layer.md)

**Core fact layer (Tasks 0–17)**

| # | Task | Status | Notes |
|---|---|---|---|
| 11.1 | `PromptFact` + `PromptContextBlock` types (`services/prompt_facts/types.py`) | DONE | `id`, `polarity`, `strength`, `priority`, `text`, `data` fields |
| 11.2 | Threshold helpers (`thresholds.py`) | DONE | Shared RSI/EMA/ATR boundary constants |
| 11.3 | 11 fact builders | DONE | EMA, RSI, MACD, Fibonacci, BBands, VWAP, ATR, Stochastic, OBV, ADX, Volume — each in `services/prompt_facts/` |
| 11.4 | Dispatcher (`build_prompt_facts`) | DONE | Priority boost by `indicator_priority`; canonical sort (strength → priority → id); multi-timeframe aware |
| 11.5 | Renderer (`render_prompt_facts`) | DONE | Deterministic text: `=== TF (close=$X) ===`, `Verified Facts:` / `Cautions:` sections |
| 11.6 | Truncator (`truncate_by_value`) | DONE | Drops lowest-priority facts first; protects caution/high-tf facts; leaves budget headroom for system + chat history |
| 11.7 | 109 unit tests | DONE | Full coverage of all builders, dispatcher, renderer, truncator |

**Integration (Tasks 18–24)**

| # | Task | Status | Notes |
|---|---|---|---|
| 11.8 | `OllamaLifecycle.show_model()` | DONE | Queries `/api/show`; returns `model_info` dict or `None` on failure |
| 11.9 | `OllamaContextService` | DONE | Budget = `min(static_tier, model_max × 0.7)`, cached with `asyncio.Lock` |
| 11.10 | `AiService` refactor | DONE | `_prepare_analysis_session` → async; `indicators_display`/`indicator_names` split; accepts `OllamaContextService` |
| 11.11 | `prompt_builder.py` refactor | DONE | Thin orchestrator over fact pipeline; `_CANONICAL_HINT_ORDER`; legacy formatters left as dead code |
| 11.12 | Router update (`routers/ai.py`) | DONE | Passes `indicators_display`/`indicator_names`/`indicator_priority` to both `analyze` and `analyze_stream`; dropped `context_mode`/`context_bars` |
| 11.13 | `main.py` wiring | DONE | `OllamaContextService(ollama)` constructed and passed to `AiService` |
| 11.14 | Frontend: ATR added | DONE | `AiIndicator` union + `INDICATORS` array + `CHART_TO_AI_INDICATOR` map in `AiConfigPanel.tsx` |

**Test updates (Tasks 25–27)**

| # | Task | Status | Notes |
|---|---|---|---|
| 11.15 | `test_ai_with_fibs.py` | DONE | Legacy `"Primary fib"`/`"Source: MANUAL"` → `D.fibonacci.*` fact-ID assertions |
| 11.16 | `test_prompt_budget.py` | DONE | Migrated to `_static_budget_for_model` + async `OllamaContextService` tests |
| 11.17 | Eval harness (`test_prompt_facts_eval.py`) | DONE | syrupy snapshots for TSM extension, AAPL in-swing, NVDA EMA stack; structural guards (no legacy labels, `Verified Facts` header present) |

**Final count: 966 backend tests, 0 failures.**

**Cross-cutting invariants introduced:**

- `PromptFact.id` format is `{tf}.{indicator}.{condition}` — never change this structure; the renderer, truncator, and system prompt hint all key off it.
- Fact builders are pure functions: `(symbol, timeframe, candles, indicator_result) → list[PromptFact]`. No I/O, no side effects.
- `build_system_prompt` hint section must come **before** the `"Indicators provided:"` line so the canonical hint order isn't broken by an early `indicators_display` occurrence.
- `OllamaContextService` is the single source of truth for prompt budgets in production. The static `get_budget_for_model` in `prompt_builder.py` is legacy — use `_static_budget_for_model` from `ollama_context.py` for tests.
- To update eval snapshots after an intentional prompt change: `pytest tests/test_prompt_facts_eval.py --snapshot-update`

---

### Phase 12: Parallax Rules/Fib Closeout — COMPLETE

> Goal: Finish the Parallax v1 user-side trigger workflow before moving to Inflect: make rules understandable, make Today actions reliable, support trigger creation from Analysis, and tie Fibonacci alerts to the visible chart fib.
> Merged to `dev`: `b056ef3` (`fix: clean up Parallax trigger rules UX`) and `766dbe7` (`feat: add fib chart trigger`).

| # | Task | Status | Notes |
|---|---|---|---|
| 12.1 | Today hit action reliability | DONE | Fixed dismiss/snooze false-failure toasts caused by no-content responses. Cards now remove after successful action without misleading error feedback. |
| 12.2 | Watchlist mutation safety | DONE | Fixed IBKR watchlist member extraction so adding one stock does not overwrite existing members. |
| 12.3 | Rule-builder readability | DONE | EMA/VWAP rules are presented as price-vs-indicator logic. Threshold `0` is internal only; UI shows `Auto`. Numbers use readable labels and commas where displayed. |
| 12.4 | Rule templates | DONE | Create-rule modal has fixed max height with vertical scroll, custom templates can be deleted, and built-in template cleanup is handled without exposing retired templates. |
| 12.5 | Analysis-side trigger creation | DONE | Analysis `Triggers` tab can create per-stock rules prefilled with the active conid/symbol/timeframe. |
| 12.6 | Fib chart-tied trigger | DONE | Fib panel has `Create alert`, which creates a per-stock trigger for the current chart symbol/timeframe when price enters the visible fib golden pocket. |
| 12.7 | EMA set restriction | DONE | User-facing EMA rules expose only EMA 9, 21, 50, and 200. |
| 12.8 | Compare line colors | TODO | Make stock/reference line colors customizable and light-mode-safe. Current hardcoded stock white can disappear in light mode. |

**Verification already run for Phase 12:**

- `npm test -- src/components/ai/__tests__/FibStackPanel.test.tsx src/components/triggers/__tests__/ConditionsList.test.tsx`
- `uv run pytest tests/test_trigger_conditions_eval.py -q`
- `./node_modules/.bin/vite build`

**Known verification limitation:** latest local `npm run build` passes, but Vite still warns about the large main bundle and `src/store/chart.ts` being both statically and dynamically imported.

---

### Orbit v2 Roadmap

These are deliberately outside the v1 release gate. v1 remains local-first and
paper/live-safety guarded. v2 can add optional cloud and TWS-mode capabilities,
but only behind explicit settings and connection gates.

**Primary v2 themes**

1. **TWS-gated execution assistant**
   - Ships as a fourth Orbit module under a working name until product naming.
   - Only available when TWS is connected and explicitly selected by the user.
   - TWS mode is exclusive: Parallax, MoonMarket, and Inflect are disabled because
     their contracts depend on Client Portal data.
   - Starts in paper mode before any separately approved live path.
   - Uses `ib_async` only behind Orbit's `TwsBrokerAdapter`; third-party types do
     not leak into services, database/API models, or UI.
   - Uses NautilusTrader as an architecture reference, not a dependency.
   - Handles tiered scale-outs, trailing/advanced order management, GTD, MOC/LOC,
     and multi-leg option strategy execution after single-leg validation.
   - Must have its own safety design: live-account guardrails, max order size,
     max daily loss, manual arming, kill switch, audit log, and replayable order
     intent history.
   - Not autonomous trading: AI, scanners, and triggers cannot place, arm,
     modify, or cancel orders. Every order must be created by, or execute
     within, a user-reviewed and user-armed plan.

2. **Cloud LLM provider support**
   - The current cloud analysis surface uses authenticated fixed OpenRouter
     models. Direct OpenAI, Anthropic, Gemini, and Grok controls are deferred.
   - Local Ollama remains the default. It is used as fallback only when the user
     enables the explicit `cloud_with_local_fallback` routing mode.
   - API keys live only in the OS keychain and are never logged. SQLite may
     store only an opaque `api_key_ref`; there is no encrypted SQLite fallback.
   - Analysis owns persistent provider, model, and fallback selection. Settings
     owns provider status and API-key save/remove only.
   - Orbit records metadata-only usage and cost receipts. Provider accounts own
     budgets and caps; Orbit does not enforce an aggregate monthly cap.

3. **Hybrid agentic inference**
   - Split work between local and cloud models instead of treating provider choice
     as one global toggle.
   - Local model handles cheap/private/repetitive tasks: summarizing cached market
     context, extracting facts, validating schemas, ranking watchlist candidates,
     and pre-filtering candidate plans.
   - Frontier cloud model handles higher-value reasoning: trade thesis critique,
     multi-step plan synthesis, disagreement resolution, and final natural-language
     analysis.
   - Add a router that chooses model/provider per task based on privacy, cost,
     latency, context size, and required reasoning quality.
   - Every cloud call must receive structured facts, not raw uncontrolled app
     state. The prompt-fact layer remains the boundary.

**Other v2 roadmap items**

- Fib learning algorithm: automatic price-outcome tracking for every surfaced
  fib, `fib_analyses`/`fib_outcomes`, and evolving weights. Learning is never
  based on whether the user traded the setup; optional analysis feedback is a
  supplementary signal only.
- Cross-indicator confluence engine: explicit fib/EMA/Bollinger/VWAP overlap
  detection before the prompt layer.
- News-candle-aware fib anchor selection: earnings/news candles become preferred
  swing anchors when criteria match.
- Watchlist-aware / peer-relative AI analysis beyond the current prompt framing.
- Multi-account support.
- Option bracket parity after single-leg paper validation.
- System tray mode with persistent scanning.
- Ichimoku Cloud, Supertrend, 52-week indicators.
- Export analysis as PDF/image.
- Mobile companion (read-only dashboard).
- Keyboard shortcuts.
- Backup / restore SQLite (watchlists, triggers, settings export).
- Read-only Parallax-analysis links from Inflect. Journal outcomes must not feed
  the fib-learning algorithm.

> **Inflect (trading journal)** is Phase 4 of the Orbit roadmap, built after Parallax and MoonMarket.

---

## Inflect (trading journal) — v1 shipped (2026-06-02)

Inflect is the third Orbit module: a Tradezella-style journal. v1 turns the
shared `fills` projection into round-trip trades on demand, attributes realized
P&L to a monthly calendar, and lets the user annotate each trade. It rides the
existing FastAPI sidecar and SQLite DB — no new services and no
Parallax/MoonMarket journal hooks (`docs/architecture/modules.md`).

### v1 scope (what shipped)

- **Backend** (`/inflect/*`): FIFO round-trip matcher (`services/inflect/matcher.py`),
  on-demand trade derivation + calendar aggregation + journal CRUD
  (`services/inflect/service.py`), extended-hours-gated background fills sync
  (`services/inflect_sync.py`), and a thin router (`routers/inflect.py`). The
  only persisted Inflect-owned table is `journal_entries`, keyed by a stable
  `trade_id` so annotations survive re-derivation.
- **Frontend** (`src/modules/inflect/`): launcher tile + `/inflect/*` route,
  monthly P&L calendar (Sunday-start grid + weekly rail), round-trip trades
  table with OPEN/CLOSED filter, trade-detail drawer (stats + fills), and a
  setup/notes/tags journal editor. Zustand view store + TanStack Query hooks.
- **Basis recovery pass**: incomplete-basis trades now surface as repairable
  instead of becoming phantom shorts. The app can synthesize starting lots from
  IBKR Performance & Reports data, show basis-lot status, let the user manually
  repair basis, search trades by symbol, and clear Inflect-owned storage when a
  reset is needed.
- **Tests**: 50 backend (matcher, calendar, sync gate, router, DB layer) +
  frontend coverage for the original journal, plus added basis-recovery,
  manual-basis, symbol-search, and storage-cleanup regression coverage.
  Latest targeted suites and frontend build are green on local `dev`.

### Locked decisions (D1–D10)

- **D1.** Trades derived on demand from `fills` via FIFO; never persisted in v1.
- **D2.** Stable `trade_id` = `{account_id}:{conid}:{first_open_execution_id}`.
- **D3.** `conid` is the instrument key throughout (`docs/architecture/modules.md`).
- **D4.** Realized P&L net of commissions, attributed to the **close** date in
  US/Eastern (the trading-day timezone).
- **D5.** Commissions prorated per fill so position flips split costs correctly
  across the closing and newly-opened trade.
- **D6.** Background sync floors at 60s and is gated to extended hours via
  `/trsrv/secdef/schedule` (cached once/day), with a hardcoded ~04:00–20:00 ET
  weekday fallback; holidays authoritatively close without fallback.
- **D7.** Setup vocabulary is a fixed list: Fib retracement, Fib extension,
  Breakout, Mean reversion, News candle, Other.
- **D8.** Options ride the same matcher via sec_type/conid (single-leg).
- **D9.** R-multiple deferred to v2 (no risk/stop captured); detail view leaves a
  slot, value always null.
- **D10.** Incomplete basis is a first-class repair state, not evidence of a
  short. Repairs must remain auditable because they affect derived realized P&L.

### v2 follow-ups

- Flex/CSV import to backfill fills beyond IBKR's ~7-day window (schema is
  import-ready; >7-day app downtime currently loses fills).
- R-multiple / planned-risk entry.
- Trade screenshots + ratings.
- Multi-leg option strategies.
- Average-cost matcher option alongside FIFO.
- Materialized `trades` cache (matcher recomputes per request today — fine for
  v1 history sizes, no API change needed to add a cache).

---

## Open Questions

| # | Question | Related Task | Status |
|---|---|---|---|
| Q1 | ~~What Ollama model for analysis?~~ | 4.10 | RESOLVED: Gemma 4 26B recommended, 4 tiers, user picks from installed |
| Q2 | ~~How to structure AI prompt with chart data?~~ | 4.10, 4.11 | RESOLVED: Structured JSON — pre-computed indicator signals |
| Q3 | Can Lightweight Charts support draggable Fibonacci? | 4.5 | OPEN — may need custom canvas overlay |
| Q4 | ~~How to get full equity universe from IBKR?~~ | 5.6 | RESOLVED: Use IBKR Scanner API presets as universe source (filtered lists, not raw universe). User picks a preset → backend runs scanner → applies indicator filters on results. |
| Q5 | ~~What defines a "news candle" for Fibonacci alerts?~~ | 6.6 | RESOLVED: Ship all 4 detection methods as user-selectable options. (A) body > 2× ATR + vol > 2× avg, (B) range > 2× ATR + vol > 1.5× avg, (C) price crosses fib + vol > 1.5× avg, (D) price within X% of fib + configurable filter. Evaluate in practice. |
| Q6 | How to calculate Market Strength gauge composite? | 3.2 | OPEN — proposal: advance/decline + % above 200 EMA + McClellan |
| Q7 | ~~Sector Rotation RRG calculation?~~ | 3.4 | RESOLVED: standard JdK method |
| Q8 | ~~Can Ollama be bundled into Tauri?~~ | 4.12 | RESOLVED: detect-only, never auto-install. Guide user instead |
| Q9 | ~~TWS API or IBKR Client Portal Web API for v1 market data/order ticket?~~ | ALL | RESOLVED: v1 stays with Client Portal Web API. TWS is not the v1 data path. |
| Q10 | What should the TWS-gated execution assistant support first? | v2 execution assistant | DRAFTED: fourth Orbit module, exclusive TWS mode, stocks and paper first; live requires settings/session/plan arming and pauses for re-arm after restart. `ib_async` stays behind `TwsBrokerAdapter`; NautilusTrader is reference only. |
| Q11 | How should hybrid local/cloud inference route tasks? | v2 AI | PARTLY RESOLVED: the current modes are `local_only`, `cloud_manual`, and `cloud_with_local_fallback`; automatic task-class routing remains deferred. |
