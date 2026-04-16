# PolySignal — Pass 2: deeper bugs + 5 improvements

## Context

The previous session fixed: SQLite UTC parsing in generator.ts/scan-cycle.ts,
RSS single-family origination, word-boundary entity negation, catalyst
rejections, per-origin push outcomes, smoke test, scanner heartbeat health,
news contradiction blocker. DO NOT redo any of that work.

This pass targets a second layer of bugs found in areas that weren't
reviewed in pass 1, plus five intent-aligned improvements.

## Ground rules (unchanged)

- Work in small sections. Build, run tests, commit after EACH section.
  `npm run build:scanner && npm run build:api && npm run test --workspace=packages/scanner && npm run test --workspace=packages/api`
- NEVER commit `.env`, `data/*.db`, `data/*.log`, `data/*.txt`, or heartbeats.
- Do NOT lower any push confidence threshold.
- Do NOT refactor the streaming/fusion layer (feature-flagged off).
- Keep existing log-prefix conventions (`[news-scanner]`, `[verify]`, etc.).
- Prefer small pure-function helpers in `utils/` over in-place edits.
- For every bug marked CRITICAL, add a focused regression test even if it
  means stubbing the clock (`vi.useFakeTimers()`) or the DB.

---

## SECTION 1 — Finish the timezone migration (CRITICAL, multiplier for Section 6)

Read ONLY `packages/scanner/src/intelligence/news-correlator.ts`,
`packages/scanner/src/signals/generator.ts` lines 1060–1230, and
`packages/scanner/src/sources/insider-scanner.ts`, and
`packages/scanner/src/sources/econ-calendar-scanner.ts`.

Section 1 of the previous pass created `packages/scanner/src/utils/time.ts`
with `parseDbTimestampMs`. It was only wired up in generator.ts:542,
generator.ts:1241, scan-cycle.ts:337, and news-catalyst-scanner.ts. The
following call sites still use raw `Date.parse`:

1. `news-correlator.ts:51` — `getRecencyWeight(timestamp)` — **this directly
   weakens the Section 6 news contradiction gate** on Stockholm time, because
   it under-counts fresh news by 1–2 hours and silently reduces the
   `weightedSources` total below the 3.5/2.0/1.0 tiers.

2. `generator.ts:1075`, `:1109`, `:1211` — three inlined ad-hoc parsers of
   the form `Date.parse(tsRaw.replace(' ', 'T') + (tsRaw.endsWith('Z') ? '' : 'Z'))`.
   These work correctly BUT duplicate logic and diverge from the canonical
   helper. Replace them with `parseDbTimestampMs` for consistency.

3. `insider-scanner.ts:148` — `Date.parse(timestamp)` on scanned trade
   timestamps. The feed may already be ISO-with-Z, but verify and convert
   to `parseDbTimestampMs`.

4. `econ-calendar-scanner.ts:152` — `Date.parse(event.date)` on ForexFactory
   data. Their JSON uses ISO with explicit offset; safe, but also route
   through `parseDbTimestampMs` for one-true-path.

Add a regression test file
`packages/scanner/src/intelligence/news-correlator.test.ts` (create if
absent). Pin the clock, insert three mock `tweet_snapshots` rows with
`scraped_at` values 5, 45, and 120 min old (in SQLite UTC format), run
`getBoostForSignal('oil-equinor', 'bull')`, and assert the 5-min row gets
`recencyWeight = 1.0`, the 45-min row gets 0.5, the 120-min row gets 0.25.
Force `process.env.TZ = 'Europe/Stockholm'` in a `beforeAll`. This test
MUST fail on `main` before the fix and pass after.

Build, test, commit: `fix(time): complete timezone migration for news-correlator and scanners`

---

## SECTION 2 — Stale-snapshot window gate (CRITICAL)

Read ONLY `packages/scanner/src/storage/snapshot-store.ts` and
`packages/scanner/src/polymarket/odds-tracker.ts`.

`calculateDelta(marketId, timeWindowMinutes)` calls `getSnapshotAt(N)` which
returns the NEAREST snapshot older than (now - N). If the scanner was down
or dormant for 6 hours, `getSnapshotAt(30)` returns a snapshot 6+ hours old.
The delta is computed over that 6h interval, but `time_window_minutes: 30`
is stamped on the OddsChange. Downstream, the scorer's time-compression
bonus awards up to +18 points for "10-minute fresh" moves that are actually
hours stale.

Fix:

- Extend the return type of `calculateDelta` with `snapshot_gap_minutes:
  number` (the actual observed gap between `now.timestamp` and
  `before.timestamp`).
- In `calculateDelta`, compute `gapMinutes` using `parseDbTimestampMs` on
  both snapshot timestamps. If
  `gapMinutes > timeWindowMinutes * 1.75`
  return `null` (not a valid window).
- Also return null if `gapMinutes < timeWindowMinutes * 0.5` — that's a
  fast-insert anomaly, e.g. two snapshots within a minute; the "window"
  is lying.
- Update `OddsTracker.detectSignificantChanges` to propagate
  `snapshot_gap_minutes` into the `OddsChange` payload, and log
  `[window]` warnings when the gap differs from the requested window by
  more than 10%.

Add unit tests in a new
`packages/scanner/src/storage/snapshot-store.test.ts` covering:
- Two snapshots exactly 30 min apart, 30-min window → valid, delta computed.
- Two snapshots 90 min apart, 30-min window → null (stale).
- Two snapshots 3 min apart, 30-min window → null (fast-insert anomaly).

Build, test, commit: `fix(odds): reject stale-window calculateDelta results`

---

## SECTION 3 — Whale direction correctness (CRITICAL for signal quality)

Read ONLY `packages/scanner/src/polymarket/types.ts` and
`packages/scanner/src/polymarket/whale-detector.ts`, and
`packages/scanner/src/polymarket/client.ts` lines 133–160.

The `Trade` type at `types.ts:42-52` declares `side: 'YES' | 'NO'`, but
the real Polymarket `data-api/trades` endpoint returns:
```
{ side: "BUY"|"SELL", outcome: "Yes"|"No", size: "...", price: "...", ... }
```

The whale detector at `whale-detector.ts:115-117` only looks at `side` and
maps `BUY→YES, SELL→NO`. A whale BUYING the NO token (= bearish on YES)
gets labeled YES (bullish). This silently corrupts every whale trade on
the NO token and directly contradicts the signal direction derived from
the same trade.

Fix:

1. Update `types.ts` `Trade`:
```ts
   export interface Trade {
     id: string;
     market_id: string;
     asset_id: string;
     side: 'BUY' | 'SELL';
     outcome?: 'Yes' | 'No' | 'YES' | 'NO';  // may be absent on old trades
     size: string;
     price: string;
     timestamp: number;
     maker: string;
     taker: string;
   }
```

2. In `whale-detector.ts`, rewrite the normalization:
```ts
   const sideRaw = String(trade.side ?? '').toUpperCase();
   const outcomeRaw = String(trade.outcome ?? 'YES').toUpperCase();
   // A BUY on the YES token is bullish on YES (→ direction 'YES').
   // A SELL on the YES token is bearish → 'NO'.
   // A BUY on the NO token is bearish on YES → 'NO'.
   // A SELL on the NO token is bullish on YES → 'YES'.
   const isBuy = sideRaw === 'BUY';
   const isYesToken = outcomeRaw === 'YES' || outcomeRaw === 'YES ';
   const direction: 'YES' | 'NO' = (isBuy === isYesToken) ? 'YES' : 'NO';
```

3. If `trade.outcome` is missing on older trades, default to 'YES'
   (conservative: preserves the existing buggy behavior for unknown
   legacy data rather than reversing it).

4. Log the outcome tag in the whale log line so it's auditable:
   `console.log(\`  🐋 ${market.title.substring(0,40)}... ($${sizeUsd.toFixed(0)}) ${sideRaw}-${outcomeRaw} → ${direction}\`);`

Add a unit test in
`packages/scanner/src/polymarket/whale-detector.test.ts` (create if absent)
with four cases — BUY/Yes, SELL/Yes, BUY/No, SELL/No — and assert the
derived direction is correct for each.

Build, test, commit: `fix(whale): derive direction from side × outcome, not side alone`

---

## SECTION 4 — Stop parsing reasoning strings as structured data (CRITICAL correctness)

Read ONLY `packages/scanner/src/signals/types.ts`,
`packages/scanner/src/storage/signal-store.ts` lines 1–100 and 625–640,
`packages/scanner/src/alerts/dispatcher.ts` lines 900–930,
`packages/scanner/src/intelligence/push-tracker.ts` lines 260–327, and
`packages/scanner/src/jobs/scan-cycle.ts` lines 300–410.

Multiple code paths parse `signal.reasoning` (a human-readable log) to
extract source-type information. This is brittle AND wrong:

- `dispatcher.ts:919` `reasoningLower.includes('technical')` false-positives
  on any tag containing the word "technical".
- `dispatcher.ts:925` `reasoningLower.includes('macro')` matches BOTH
  `econ_surprise` catalysts AND the `[macro:event,+Xmin]` macro-window
  boost tag — so every signal in a macro window gets a phantom macro
  source → +1 evidence score and unlocks the catalyst execution override.
- After the Section-2 rename to `rss_news`, the parser still only looks
  for 'finviz' / 'volume spike' / '[news:+' — so RSS-hybrid signals are
  invisible to the evidence gate's news credit.
- `reasoningLower.includes('poly-confirms') || includes('cross-source')`
  always fires for hybrids → permanent +2 "polymarket source present"
  bonus stacked on top of the real count.
- `push-tracker.extractSourceCount` and `signal-store.estimateSourceCount`
  both parse `[catalysts:N]` via regex.

Fix — replace reasoning-string parsing with a structured column:

1. Add to `signals/types.ts` `GeneratedSignal`:
```ts
   confirming_source_families?: string[];  // e.g. ['news','technical','polymarket']
```
   and to `storage/signal-store.ts` `Signal`:
```ts
   confirming_source_families?: string[];
   source_count_override?: number | null;
```

2. Add a DB migration in `storage/db.ts` (check `IF NOT EXISTS`):
```sql
   ALTER TABLE signals ADD COLUMN confirming_source_families TEXT;
   ALTER TABLE signals ADD COLUMN source_count_override INTEGER;
```
   Both nullable. `confirming_source_families` stores a JSON-encoded array
   (comma-joined strings also acceptable if you prefer — be consistent).

3. Update the signal insert path to persist these columns. Update
   `findFiltered`/row → Signal decoding to read them.

4. In `scan-cycle.ts` during enrichment (where the
   existing `describeCatalystFamilies` / cross-source detection runs, around
   lines 334–405), POPULATE `signal.confirming_source_families` from the
   actual `allCatalysts` bucket filtered by assetId+direction, NOT from
   reasoning-string sniffing. Also set `source_count_override` to the count
   of distinct catalysts confirming the signal (before family dedup).

5. In `generateCatalystSignals` (`generator.ts` ~line 613 where the signal
   is created), populate the same fields from `alignedCatalysts` /
   `familySet`.

6. `dispatcher.ts extractCatalystSourceTypes`: rewrite to read
   `signal.confirming_source_families` directly. Delete the string-sniffing
   fallback — if the field is missing/empty, return an empty set.

7. `push-tracker.ts extractSourceCount`: use
   `signal.source_count_override ?? (origin==='hybrid' ? 2 : origin==='catalyst_convergence' ? 2 : 1)`.
   Do not regex `reasoning`.

8. `signal-store.ts estimateSourceCount`: same fix.

9. Update the `reasoning` string to NOT contain the structural hints — keep
   it for human reading but do NOT let it be the source of truth. In
   particular, add tests that assert the evidence gate behaves the same
   whether the reasoning string contains the word "technical"/"macro"/etc
   or not.

10. Add `dispatcher.test.ts` covering:
    - Hybrid signal with `confirming_source_families: ['news','technical']`
      and a reasoning string that happens to contain the word "macro" from
      an unrelated tag → evidence gate should NOT credit macro.
    - Hybrid with `confirming_source_families: ['rss_news']` and a
      reasoning string with no "finviz"/"news:" tokens → evidence gate
      SHOULD credit news.

Build, test, commit: `fix(evidence): stop parsing reasoning strings; use structured source families`

---

## SECTION 5 — Macro calendar timezone bug

Read ONLY `packages/scanner/src/intelligence/macro-calendar.ts`.

`nextMonthlyDay`, `nextFirstWeekdayOfMonth`, `firstWeekdayOfMonth` (lines
152–200) build Date objects with
`new Date(year, month, day, hour, minute, 0, 0)`. This is LOCAL TIME. On
Stockholm, "FOMC 14:00 ET" (hour=14 in the code) is stored as 14:00
Stockholm = ~06:00 UTC — four to six hours before the actual release.
The `isInEventWindow` check and the `macroPreDriftBoost` in scan-cycle.ts
fire at the wrong time.

Fix:

- Add a helper at the top of the file:
```ts
  /**
   * Build a UTC epoch ms for a given calendar date at a given wall-clock
   * time IN a named IANA timezone. Uses an Intl-based inverse lookup
   * (build a Date in a test UTC, check how the target TZ formats it,
   * compute offset, invert).
   */
  function buildInZone(year: number, month: number, day: number, hour: number,
                       minute: number, tz: string): Date { ... }
```
- Fed/FOMC events use `America/New_York`.
- ECB uses `Europe/Frankfurt`.
- Riksbank uses `Europe/Stockholm`.
- BOE uses `Europe/London`.
- OPEC is variable but Vienna (`Europe/Vienna`) is the closest default.

- Replace every `new Date(year, month, day, hour, minute, ...)` in this
  file with `buildInZone(...)` passing the appropriate tz.

- Fallback: if `buildInZone` fails for any reason, log a warning and
  return the old local-time Date (no silent correctness regression, but
  a warn so the issue is visible in logs).

Add a unit test file
`packages/scanner/src/intelligence/macro-calendar.test.ts` that asserts
an FOMC call at "14:00 ET" on a chosen date (e.g. 2026-05-06) resolves
to `18:00Z` in winter / `18:00Z` in summer — compute the correct UTC
and lock it in. Force `process.env.TZ = 'Europe/Stockholm'` in `beforeAll`.

Build, test, commit: `fix(macro): build event times in event timezone, not host local time`

---

## SECTION 6 — Kill dead broken emoji code + unify scanner lock

Read ONLY `packages/scanner/src/alerts/homeassistant.ts` and
`packages/scanner/src/utils/scanner-lock.ts` and
`scripts/continuous-scan.js`.

### 6a — Delete `sendAggregated`

`homeassistant.ts:36-61` `sendAggregated` contains literal `'????'` where
flag emojis should be. It's dead code (not called anywhere in scanner
source) but will ship garbage if ever re-enabled.

Delete the entire `sendAggregated` method. Leave a one-line comment above
`send`:
```ts
// Aggregated multi-signal sends have been removed. One push = one signal.
```

### 6b — Unify the lock files

`utils/scanner-lock.ts` creates `data/scanner.lock`. `continuous-scan.js`
creates `data/continuous-scan.lock`. Two locks for the same purpose.

Fix: have `continuous-scan.js` acquire the `ScannerLock` from
`dist/utils/scanner-lock.js` instead of its own separate file. Remove
the `acquireLockOrExit` / `releaseLock` functions from continuous-scan.js
and replace them with a ScannerLock import. Also delete the
`data/continuous-scan.lock` file path references.

If that refactor feels intrusive, the minimally invasive fix is: in
`continuous-scan.js` `acquireLockOrExit`, ALSO check for
`data/scanner.lock` before acquiring. But the unified approach is
preferred.

Build, test, commit: `chore(locks): unify scanner lock; remove dead sendAggregated`

---

## SECTION 7 — SIGKILL fallback in runBinary

Read ONLY `packages/scanner/src/utils/local-ai-cli.ts` lines 143-204.

Add a SIGKILL escalation after SIGTERM:
```ts
const timer = setTimeout(() => {
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
  }, 2000);
  child.once('close', () => clearTimeout(killTimer));
  finish(() => reject({ code: 'ETIMEDOUT', message: `timeout after ${timeoutMs}ms` }));
}, timeoutMs);
```

Also clamp stdin writes: if `child.stdin.write(prompt)` returns false,
await `'drain'` once before calling `child.stdin.end()`. This prevents
hangs on very long prompts during briefing batch mode.

Build, commit: `fix(ai-cli): SIGKILL fallback and drain-aware stdin write`

---

## SECTION 8 — Transactional thesis replacement in generator

Read ONLY `packages/scanner/src/signals/generator.ts` lines 429–470 and
`packages/scanner/src/storage/signal-store.ts` lines 80–120 and the
`delete` method.

The thesis-replacement path does `signalStore.delete(existingThesisBest.id)`
followed by `signalStore.insert(signal)`. If the insert fails, the thesis
is lost.

Add a `signalStore.replaceInTransaction(oldId: string, newSignal:
InsertSignal): void` method that wraps both operations in a
`db.transaction(...)` block. Replace the two calls in generator.ts with
one call to `replaceInTransaction`.

Add a smoke test that:
- Inserts a signal.
- Calls `replaceInTransaction` with a signal whose id intentionally
  duplicates a different existing signal (causing INSERT to fail).
- Asserts the original thesis signal is STILL present (delete rolled back).

Build, test, commit: `fix(signal-store): transactional thesis replacement`

---

## SECTION 9 — Improvement: net-of-cost outcome tracking

Read ONLY `packages/scanner/src/intelligence/push-tracker.ts` and
`packages/scanner/src/intelligence/execution-feasibility.ts` and
`packages/scanner/src/storage/db.ts` (for the `push_outcomes` schema).

Adam trades 3x certificates on Avanza. TP/SL as measured today:
`movePct >= 3` = certificate +9%, `movePct <= -2` = certificate -6%.
BUT this ignores spread. The real trader P&L has to subtract round-trip
cost both legs.

Add:

1. A new column on `push_outcomes`: `net_max_favorable_pct REAL`
   (nullable), and `estimated_round_trip_cost_pct REAL` (nullable).
   Migration with IF NOT EXISTS.

2. At `ensurePendingOutcomeRows` time, compute
   `estimateExecutionCost(asset_id, 3).roundTripCostPct` and persist
   it on the row so it's frozen at the time of the push.

3. At `evaluateSingle` time, after computing `maxFavorable`, compute
   `netMaxFavorable = maxFavorable - (storedCostPct * 100)`. Persist.

4. Extend the `/api/push-outcomes` endpoint to return both raw and net
   fields. The dashboard already exists — just expand the payload, no
   UI change needed in this section.

5. Add a small unit test covering the math: a 4% underlying move with
   0.8% round-trip cost → `netMaxFavorable = 3.2`.

The goal is that when Adam looks at the dashboard, he sees the number
that actually maps to his P&L, not just the directional move.

Build, test, commit: `feat(outcomes): track net-of-cost P&L on push outcomes`

---

## SECTION 10 — Improvement: Wilson-score confidence intervals

Read ONLY `packages/api/src/routes/push-outcomes.ts`.

With 3–8 samples, a "60% hit rate" is noise. The endpoint should return,
for every grouped cell (by origin, by asset, by source family), the
Wilson score 95% CI bounds.

Add a helper in the api package:
```ts
// Wilson score interval for a binomial proportion
function wilsonInterval(successes: number, total: number, z = 1.96):
  { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const phat = successes / total;
  const denom = 1 + (z*z)/total;
  const centre = phat + (z*z)/(2*total);
  const margin = z * Math.sqrt((phat*(1-phat) + (z*z)/(4*total)) / total);
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom)
  };
}
```

For every aggregated block the endpoint returns (origin summary, per-asset,
per-source-family), compute `hitRateCI = wilsonInterval(tpCount, evalCount)`
and include both the point estimate and `{ lower, upper }`.

Add a smoke test:
- `wilsonInterval(3, 5)` → lower ~0.23, upper ~0.88 (wide — that's the point).
- `wilsonInterval(60, 100)` → lower ~0.50, upper ~0.69.

Lock the numbers with `toBeCloseTo`.

Build, test, commit: `feat(outcomes): Wilson CI bounds on hit-rate aggregates`

---

## SECTION 11 — Improvement: real live-push canary script

Create `scripts/test-signal.js`. Rules:

- Requires `--confirm` CLI flag to run; otherwise print usage and exit.
- Does NOT set `DRY_RUN`. This is the opposite of the smoke test — it
  actually pushes to the phone through the real dispatcher.
- Synthesizes ONE signal: asset `oil-equinor`, confidence 82, delta 25,
  verification_status approved, verification_source 'fallback_guard' with
  `score: 75`, `signal_origin: 'polymarket'`, `suggested_action: 'BULL Equinor (TEST)'`,
  `market_title: 'POLYSIGNAL LIVE-PUSH CANARY — NOT A REAL SIGNAL'`.
- Inserts it via the live `SignalStore` with a `push_gate_outcome` of
  `'canary_pending'`.
- Calls `alertDispatcher.dispatchBatch([syntheticSignal])`.
- Prints the resulting `push_gate_outcome`. Expected: `'pushed: all gates passed'`.
- If the outcome is anything else, exit with code 1 and a clear message.
- Adds `"canary:push": "node scripts/test-signal.js"` to root package.json.
- After 5 minutes, runs a second DB query that deletes / flags the canary
  signal so it doesn't pollute performance stats:
  `UPDATE signals SET signal_origin='canary', status='dismissed' WHERE id = ?`.

Document in the script header:
- Run manually from the scanner host once per week.
- Confirms the *entire* push chain (dispatcher → HA → phone). Without it,
  Adam can't distinguish "no qualifying signal" from "pipeline broken".
- The synthetic signal is intentionally tagged so the `push_outcome`
  evaluator can filter it from real performance stats.

Also update `packages/scanner/src/intelligence/push-tracker.ts`
`ensurePendingOutcomeRows` to EXCLUDE signals where
`signal_origin = 'canary' OR status = 'dismissed'`.

Build, commit: `feat(canary): scripts/test-signal.js for weekly live-push canary`

---

## SECTION 12 — Improvement: drift-safe window (already covered in Section 2, verify)

Verify Section 2 covered this and move on. No work here.

---

## SECTION 13 — Final verification

Run:
```bash
npm run build:scanner
npm run build:api
npm run test --workspace=packages/scanner
npm run test --workspace=packages/api
npm run smoke:push
```

All must pass. Do NOT run `npm run canary:push` in CI — it pushes to the
real phone.

After a clean single-instance restart of the scanner, paste the output of
these DB queries in the final summary (do NOT commit the output):
```bash
sqlite3 data/polysignal.db \
  "SELECT signal_origin, verification_status, COUNT(*) FROM signals WHERE timestamp >= datetime('now','-24 hours') GROUP BY 1,2;"

sqlite3 data/polysignal.db \
  "SELECT reason_key, COUNT(*) FROM catalyst_rejections WHERE ts >= datetime('now','-24 hours') GROUP BY 1;"

sqlite3 data/polysignal.db \
  "SELECT confirming_source_families, COUNT(*) FROM signals WHERE timestamp >= datetime('now','-24 hours') AND signal_origin='hybrid' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;"

sqlite3 data/polysignal.db \
  "SELECT COUNT(*), AVG(max_favorable_pct), AVG(net_max_favorable_pct), AVG(estimated_round_trip_cost_pct) FROM push_outcomes WHERE evaluated_at IS NOT NULL;"
```

The third query should show NON-empty `confirming_source_families` values
for hybrid signals created after the Section 4 fix. If the column is all
NULL, Section 4 isn't wired to the enrichment path correctly — go back
and fix.

---

## Out of scope

- Changing any confidence threshold.
- Changing scan intervals or dormant mode rules.
- Avanza instrument refresh.
- Dashboard React changes (the API changes flow through without UI edits).
- Ontology file edits.
- Changing TP/SL percentages.
- Streaming/fusion layer.

## When done

Short summary:
1. Which sections passed first try vs needed iteration.
2. The four DB query outputs from Section 13.
3. Any surprises — especially in Section 4, which touches the most
   downstream code.
4. If Section 3's whale fix changed the direction on any recent whale
   trades, include a count of direction flips you'd observe in the last
   7 days (SELECT COUNT(*) FROM whale_events WHERE side = 'NO').