## Date
2026-03-05

## Goal
Add a robust AI-verified trade gating layer with deterministic entity validation, and fix high-impact quality bugs without breaking runtime behavior.

## Files Read
- `packages/scanner/src/index.ts`
- `packages/scanner/src/signals/generator.ts`
- `packages/scanner/src/signals/ai-ranker.ts`
- `packages/scanner/src/intelligence/trading-hours.ts`
- `packages/scanner/src/storage/db.ts`
- `packages/scanner/src/storage/signal-store.ts`
- `packages/scanner/src/storage/whale-store.ts`
- `packages/scanner/src/polymarket/market-discoverer.ts`
- `packages/scanner/src/correlation/ontology.ts`
- `packages/scanner/src/correlation/auto-mapper.ts`
- `packages/scanner/src/alerts/dispatcher.ts`
- `packages/api/src/routes/signals.ts`
- `packages/dashboard/src/pages/Index.tsx`
- `scripts/continuous-scan.js`
- `scripts/refresh-instruments.js`

## Files Modified (with brief change notes)
- `packages/scanner/src/config.ts`: added verification env config.
- `packages/scanner/src/storage/db.ts`: added signal verification columns + tracked market `event_slug` migration.
- `packages/scanner/src/storage/signal-store.ts`: persisted verification metadata and decision record.
- `packages/scanner/src/signals/types.ts`: added verification fields to generated signals.
- `packages/scanner/src/signals/generator.ts`: integrated verification gate before persistence/actionability.
- `packages/scanner/src/verification/types.ts`: verification contracts.
- `packages/scanner/src/verification/knowledge-base.ts`: offline allowlist/relationship loader.
- `packages/scanner/src/verification/entity-guard.ts`: deterministic entity and relevance gate.
- `packages/scanner/src/verification/ai-verifier.ts`: Claude CLI verifier with strict JSON parsing.
- `packages/scanner/src/verification/trade-gate.ts`: guard + AI orchestration and fallback policy.
- `packages/scanner/src/correlation/auto-mapper.ts`: keyword evidence extractor for verification context.
- `packages/scanner/src/alerts/dispatcher.ts`: verification-required push gating.
- `packages/scanner/src/signals/ai-ranker.ts`: verified-by-default ranking + exported dedup helper.
- `packages/scanner/src/intelligence/trading-hours.ts`: deterministic time helpers for testability.
- `packages/scanner/src/intelligence/engine.ts`: briefings now use verified signals.
- `packages/scanner/src/storage/market-store.ts`: `event_slug` persistence.
- `packages/scanner/src/polymarket/types.ts`: optional event slug fields.
- `packages/scanner/src/polymarket/market-discoverer.ts`: stores `event_slug` when available.
- `packages/scanner/src/storage/whale-store.ts`: stronger dedup query (window-function based).
- `packages/scanner/src/avanza/scraper.ts`: explicit zero-result diagnostics.
- `packages/scanner/src/avanza/search-client.ts`: per-query search diagnostics.
- `packages/scanner/src/index.ts`: wired verification gate and startup instrument diagnostics.
- `packages/api/src/routes/signals.ts`: verified top-trades gating, parse helpers, verification detail rendering, and Polymarket link fallback.
- `packages/dashboard/src/hooks/useTopSignals.ts`: verified-only default + debug toggle support.
- `packages/dashboard/src/pages/Index.tsx`: UI toggle for verified/all and verification visibility.
- `packages/dashboard/src/types/index.ts`: added verification fields.
- `.env.example`: added verification env vars.
- `.gitignore`: ignore lock files.
- `scripts/run-scan.js`: fixed outdated result field names.
- `scripts/refresh-instruments.js`: improved zero-instrument diagnostics.
- `data/entity-allowlist.json`: known-person allowlist seed.
- `data/entity-knowledge.json`: offline relationship/allowlist keyword seed.
- `packages/scanner/src/verification/entity-guard.test.ts`: guard tests.
- `packages/scanner/src/intelligence/trading-hours.test.ts`: per-market time tests.
- `packages/scanner/src/signals/ai-ranker.test.ts`: per-asset dedup test.

## Reasoning / Decisions
- Enforced verification before actionability, but kept rejected/unverified records in DB for transparency and debugging.
- Used offline-first guard + knowledge seed to prevent semantic false positives quickly and deterministically.
- Kept Claude verification as augmenting layer with strict fallback to avoid accidental auto-approval when CLI fails.
- Preserved existing architecture by integrating at `SignalGenerator` and `AlertDispatcher` boundaries.

## Implementation Notes
- Signals now carry `verification_status`, `verification_score`, `verification_reason`, `verification_flags`, `verification_source`, and `verification_record`.
- Top trades are verified-only by default; debug query/UI can include unverified signals.
- Morning briefing generation now consumes only verified signals.

## Commands Run (if any)
- Repository inspection and file reads via shell.
- `npm run test --workspace=packages/scanner`
- `npm run build:scanner`
- `npm run build:api`
- `npm run build:dashboard`

## Tests Run + Results
- Scanner tests: 3 files, 7 tests, all passed.
- Scanner TypeScript build: passed.
- API TypeScript build: passed.
- Dashboard build: passed (existing bundle-size warning remains).

## Risks / TODO
- Claude verifier quality still depends on local CLI availability and model output consistency.
- Knowledge graph is intentionally small; expand cautiously with high-confidence relationships only.
- Consider adding API-level pagination/filtering for rejected signals in dashboard debug views.

---

## Date
2026-03-05

## Goal
Add close-time backtesting and a practical daily self-improvement loop focused on 10-60 minute post-signal market reaction.

## Files Read
- `scripts/continuous-scan.js`
- `scripts/self-improve.js`
- `packages/scanner/src/jobs/scan-cycle.ts`
- `packages/scanner/src/alerts/dispatcher.ts`
- `packages/scanner/src/storage/db.ts`
- `packages/scanner/src/storage/signal-store.ts`

## Files Modified (with brief change notes)
- `packages/scanner/src/storage/db.ts`: added `signal_outcomes`, `daily_backtest_runs`, `asset_performance`, and signal push timestamp/channel columns.
- `packages/scanner/src/storage/signal-store.ts`: added push-marking and performance-adjustment lookup.
- `packages/scanner/src/backtest/price-client.ts`: Yahoo minute-data retrieval.
- `packages/scanner/src/backtest/symbol-map.ts`: asset-to-symbol mapping for evaluation.
- `packages/scanner/src/backtest/evaluator.ts`: daily backtest engine + rolling performance + optional Claude notes.
- `packages/scanner/src/index.ts`: exposed `runDailyBacktest()` and wired evaluator.
- `scripts/continuous-scan.js`: added close-time automatic backtest execution.
- `packages/scanner/src/jobs/scan-cycle.ts`: applies learned confidence adjustments from `asset_performance`.
- `packages/scanner/src/alerts/dispatcher.ts`: stricter intraday push gate + push-success callback.
- `packages/scanner/src/alerts/types.ts`: added intraday threshold and push callback config.
- `scripts/self-improve.js`: now includes backtest-driven learning summary.
- `packages/api/src/routes/backtest.ts`: backtest run/outcome/performance API endpoints.
- `packages/api/src/index.ts`: mounted `/api/backtest`.
- `.env.example`: added `ALERT_MIN_CONFIDENCE_HA_INTRADAY`.
- `docs/backtest_learning_system.md`: operational and strategy documentation.

## Reasoning / Decisions
- Used additive DB tables to avoid refactoring existing signal flow.
- Backtest targets your actual execution horizon (10-60 minutes) instead of end-of-day PnL.
- Learning loop adjusts confidence conservatively per asset to reduce mid-day noise.
- Push gating tightened to reserve notifications for highest-quality setups.

## Implementation Notes
- Backtests run once/day/market in close windows; duplicate runs are prevented by unique `(date, market)` in `daily_backtest_runs`.
- Entry time prioritizes `push_sent_at` so post-push reaction is measured accurately.
- Outcome correctness thresholds are intentionally conservative and can be tuned.

## Commands Run (if any)
- `npm run test --workspace=packages/scanner`
- `npm run build:scanner`
- `npm run build:api`

## Tests Run + Results
- Scanner tests: 7/7 passed.
- Scanner build: passed.
- API build: passed.

## Risks / TODO
- Yahoo intraday coverage for some OTC/ADR symbols can be sparse; those signals may be skipped in outcome calculation.
- Add dashboard page for backtest/performance endpoints (currently API-only).
- Tune correctness thresholds and adjustment formula after 1-2 weeks of real outcomes.
