import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { YahooPriceClient, PricePoint } from './price-client.js';
import { getYahooSymbol } from './symbol-map.js';
import { SWEDISH_MARKET_ASSETS, US_MARKET_ASSETS } from '../intelligence/trading-hours.js';

const execFileAsync = promisify(execFile);

const CLAUDE_CANDIDATES = [
  'claude',
  'claude.cmd',
  'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude',
  'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude.cmd',
  '/usr/local/bin/claude',
  '/usr/bin/claude'
];

interface SignalCandidate {
  id: string;
  timestamp: string;
  push_sent_at: string | null;
  market_title: string;
  matched_asset_id: string;
  matched_asset_name: string;
  suggested_action: string;
  confidence: number;
  verification_score: number;
}

interface OutcomeInsert {
  signal_id: string;
  market: 'swedish' | 'us';
  asset_id: string;
  asset_name: string;
  symbol: string;
  entry_time: string;
  entry_price: number;
  move_10m_pct: number | null;
  move_30m_pct: number | null;
  move_60m_pct: number | null;
  favorable_peak_60m_pct: number | null;
  adverse_peak_60m_pct: number | null;
  direction_correct_30m: number | null;
  direction_correct_60m: number | null;
  confidence_at_signal: number;
  verification_score: number;
  source: string;
}

export interface BacktestRunResult {
  date: string;
  market: 'swedish' | 'us';
  signalsEvaluated: number;
  hitRate30m: number;
  hitRate60m: number;
  avgMove30m: number;
  avgMove60m: number;
  aiNotes: string;
  skipped: boolean;
  candidateSignals?: number;
  skippedNoSymbol?: number;
  skippedBadTimestamp?: number;
  skippedTooFresh?: number;
  skippedNoPriceData?: number;
  candidateMode?: 'push_only' | 'hybrid';
  indicatorBreakdowns?: {
    futuresConfirmation: {
      withConfirmation: { count: number; hitRate30m: number; hitRate60m: number };
      withoutConfirmation: { count: number; hitRate30m: number; hitRate60m: number };
    };
    macroWindow: {
      withMacro: { count: number; hitRate30m: number; hitRate60m: number };
      withoutMacro: { count: number; hitRate30m: number; hitRate60m: number };
    };
    volatilityRegime: Record<string, { count: number; hitRate30m: number; hitRate60m: number }>;
  };
}

export type BacktestCandidateMode = 'push_only' | 'hybrid';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getStockholmDateString(date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
}

function directionalMovePct(entry: number, price: number, isBull: boolean): number {
  const raw = ((price - entry) / entry) * 100;
  return isBull ? raw : -raw;
}

function pickPoint(points: PricePoint[], targetMs: number): PricePoint | null {
  if (points.length === 0) return null;
  for (const point of points) {
    if (point.timestampMs >= targetMs) {
      return point;
    }
  }
  return points[points.length - 1] || null;
}

export class SignalBacktestEvaluator {
  private priceClient = new YahooPriceClient();

  constructor(private db: Database.Database) {}

  async runDailyBacktest(
    market: 'swedish' | 'us',
    date = getStockholmDateString(),
    force = false,
    options?: { mode?: BacktestCandidateMode }
  ): Promise<BacktestRunResult> {
    const mode = options?.mode ?? 'push_only';
    const readCached = (targetDate: string) => force ? undefined : this.db.prepare(`
      SELECT signals_evaluated, hit_rate_30m, hit_rate_60m, avg_move_30m, avg_move_60m, ai_notes
      FROM daily_backtest_runs
      WHERE date = ? AND market = ? AND candidate_mode = ?
      LIMIT 1
    `).get(targetDate, market, mode) as {
      signals_evaluated: number;
      hit_rate_30m: number;
      hit_rate_60m: number;
      avg_move_30m: number;
      avg_move_60m: number;
      ai_notes: string | null;
    } | undefined;

    let alreadyRan = readCached(date);
    if (alreadyRan) {
      const indicatorBreakdowns = this.calculateIndicatorBreakdowns(date, market);
      return {
        date,
        market,
        signalsEvaluated: alreadyRan.signals_evaluated || 0,
        hitRate30m: alreadyRan.hit_rate_30m || 0,
        hitRate60m: alreadyRan.hit_rate_60m || 0,
        avgMove30m: alreadyRan.avg_move_30m || 0,
        avgMove60m: alreadyRan.avg_move_60m || 0,
        aiNotes: alreadyRan.ai_notes || '',
        skipped: true,
        candidateMode: mode,
        indicatorBreakdowns
      };
    }

    // Bug A: If no signals for today yet (early morning or new filters), fall back to yesterday.
    let candidates = this.getCandidatesForDate(market, date, mode);
    if (candidates.length === 0 && date === getStockholmDateString()) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yDate = getStockholmDateString(yesterday);
      const yCandidates = this.getCandidatesForDate(market, yDate, mode);
      if (yCandidates.length > 0) {
        date = yDate;
        candidates = yCandidates;
        console.log(`[backtest] No signals for today, falling back to yesterday (${yDate})`);
        alreadyRan = readCached(date);
        if (alreadyRan) {
          const indicatorBreakdowns = this.calculateIndicatorBreakdowns(date, market);
          return {
            date,
            market,
            signalsEvaluated: alreadyRan.signals_evaluated || 0,
            hitRate30m: alreadyRan.hit_rate_30m || 0,
            hitRate60m: alreadyRan.hit_rate_60m || 0,
            avgMove30m: alreadyRan.avg_move_30m || 0,
            avgMove60m: alreadyRan.avg_move_60m || 0,
            aiNotes: alreadyRan.ai_notes || '',
            skipped: true,
            candidateMode: mode,
            indicatorBreakdowns
          };
        }
      }
    }

    if (candidates.length === 0) {
      console.log(
        `[backtest] No candidates for ${market} ${date} ` +
        `(requires approved + non-judgment + in-market assets)`
      );
    }

    const nowMs = Date.now();
    let evaluated = 0;
    let skippedNoSymbol = 0;
    let skippedBadTimestamp = 0;
    let skippedTooFresh = 0;
    let skippedNoPriceData = 0;

    for (const signal of candidates) {
      const symbol = getYahooSymbol(signal.matched_asset_id);
      if (!symbol) {
        skippedNoSymbol += 1;
        continue;
      }

      const entryIso = signal.push_sent_at || signal.timestamp;
      const entryMs = new Date(entryIso).getTime();
      if (!Number.isFinite(entryMs)) {
        skippedBadTimestamp += 1;
        continue;
      }

      // Need at least 30 minutes elapsed to evaluate short-term reaction.
      if (nowMs - entryMs < 30 * 60 * 1000) {
        skippedTooFresh += 1;
        continue;
      }

      const endMs = Math.min(entryMs + 60 * 60 * 1000, nowMs);
      const points = await this.priceClient.getSeries(symbol, entryMs, endMs);
      if (points.length < 3) {
        skippedNoPriceData += 1;
        continue;
      }

      const entryPoint = pickPoint(points, entryMs);
      if (!entryPoint || entryPoint.close <= 0) {
        skippedNoPriceData += 1;
        continue;
      }

      const isBull = signal.suggested_action.toLowerCase().includes('bull');
      const move10 = this.computeMove(points, entryPoint.close, entryMs, 10, isBull);
      const move30 = this.computeMove(points, entryPoint.close, entryMs, 30, isBull);
      const move60 = this.computeMove(points, entryPoint.close, entryMs, 60, isBull);

      const directionalSeries = points
        .filter(point => point.timestampMs >= entryMs && point.close > 0)
        .map(point => directionalMovePct(entryPoint.close, point.close, isBull));

      if (directionalSeries.length === 0) {
        skippedNoPriceData += 1;
        continue;
      }

      const favorablePeak = Math.max(...directionalSeries);
      const adversePeak = Math.min(...directionalSeries);

      const outcome: OutcomeInsert = {
        signal_id: signal.id,
        market,
        asset_id: signal.matched_asset_id,
        asset_name: signal.matched_asset_name,
        symbol,
        entry_time: new Date(entryMs).toISOString(),
        entry_price: entryPoint.close,
        move_10m_pct: move10,
        move_30m_pct: move30,
        move_60m_pct: move60,
        favorable_peak_60m_pct: favorablePeak,
        adverse_peak_60m_pct: adversePeak,
        direction_correct_30m: move30 == null ? null : (move30 > 0.2 ? 1 : 0),
        direction_correct_60m: move60 == null ? null : (move60 > 0.25 ? 1 : 0),
        confidence_at_signal: signal.confidence,
        verification_score: signal.verification_score || 0,
        source: signal.push_sent_at ? 'push_timestamp' : 'signal_timestamp'
      };

      this.upsertOutcome(outcome);
      evaluated += 1;
    }

    const summary = this.calculateSummary(date, market);
    let aiNotes = await this.generateClaudeNotes(date, market, summary);
    if (!aiNotes && evaluated === 0) {
      aiNotes =
        `No evaluable signals for ${market} ${date}. ` +
        `Candidates=${candidates.length}, noSymbol=${skippedNoSymbol}, ` +
        `badTimestamp=${skippedBadTimestamp}, tooFresh=${skippedTooFresh}, noPriceData=${skippedNoPriceData}.`;
    }
    this.storeRunSummary(date, market, summary, aiNotes, mode, evaluated);
    this.refreshAssetPerformance(market);
    this.refreshPushPerformance(market);
    this.optimizePushPolicy(market);
    const indicatorBreakdowns = this.calculateIndicatorBreakdowns(date, market);

    return {
      date,
      market,
      signalsEvaluated: evaluated,
      hitRate30m: summary.hitRate30m,
      hitRate60m: summary.hitRate60m,
      avgMove30m: summary.avgMove30m,
      avgMove60m: summary.avgMove60m,
      aiNotes,
      skipped: false,
      candidateSignals: candidates.length,
      skippedNoSymbol,
      skippedBadTimestamp,
      skippedTooFresh,
      skippedNoPriceData,
      candidateMode: mode,
      indicatorBreakdowns
    };
  }

  private getCandidatesForDate(
    market: 'swedish' | 'us',
    date: string,
    mode: BacktestCandidateMode
  ): SignalCandidate[] {
    const assetIds = market === 'swedish'
      ? Array.from(SWEDISH_MARKET_ASSETS)
      : Array.from(US_MARKET_ASSETS);
    const placeholders = assetIds.map(() => '?').join(',');

    // Prefer pushed signals first (what actually reached the phone).
    const pushedRows = this.db.prepare(`
      SELECT id, timestamp, push_sent_at, market_title, matched_asset_id, matched_asset_name,
             suggested_action, confidence, verification_score
      FROM signals
      WHERE matched_asset_id IN (${placeholders})
        AND verification_status = 'approved'
        AND requires_judgment = 0
        AND push_sent_at IS NOT NULL
        AND date(COALESCE(push_sent_at, timestamp)) = ?
      ORDER BY COALESCE(push_sent_at, timestamp) ASC
      LIMIT 240
    `).all(...assetIds, date) as SignalCandidate[];

    if (mode === 'push_only') {
      return pushedRows.slice(0, 120);
    }

    if (pushedRows.length >= 120) {
      return pushedRows.slice(0, 120);
    }

    // Fill with non-pushed high-confidence approved signals for broader learning.
    const remaining = 120 - pushedRows.length;
    const fillerRows = this.db.prepare(`
      SELECT id, timestamp, push_sent_at, market_title, matched_asset_id, matched_asset_name,
             suggested_action, confidence, verification_score
      FROM signals
      WHERE matched_asset_id IN (${placeholders})
        AND verification_status = 'approved'
        AND requires_judgment = 0
        AND push_sent_at IS NULL
        AND confidence >= 40
        AND date(timestamp) = ?
      ORDER BY confidence DESC, timestamp ASC
      LIMIT ?
    `).all(...assetIds, date, Math.max(0, remaining * 2)) as SignalCandidate[];

    const seen = new Set<string>(pushedRows.map(row => row.id));
    const merged = [...pushedRows];
    for (const row of fillerRows) {
      if (seen.has(row.id)) continue;
      merged.push(row);
      seen.add(row.id);
      if (merged.length >= 120) break;
    }

    return merged;
  }

  private computeMove(
    points: PricePoint[],
    entryPrice: number,
    entryMs: number,
    minutes: number,
    isBull: boolean
  ): number | null {
    const point = pickPoint(points, entryMs + minutes * 60 * 1000);
    if (!point) return null;
    return directionalMovePct(entryPrice, point.close, isBull);
  }

  private upsertOutcome(outcome: OutcomeInsert): void {
    this.db.prepare(`
      INSERT INTO signal_outcomes (
        signal_id, market, asset_id, asset_name, symbol, entry_time, entry_price,
        move_10m_pct, move_30m_pct, move_60m_pct,
        favorable_peak_60m_pct, adverse_peak_60m_pct,
        direction_correct_30m, direction_correct_60m,
        confidence_at_signal, verification_score, source, evaluated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(signal_id) DO UPDATE SET
        market = excluded.market,
        asset_id = excluded.asset_id,
        asset_name = excluded.asset_name,
        symbol = excluded.symbol,
        entry_time = excluded.entry_time,
        entry_price = excluded.entry_price,
        move_10m_pct = excluded.move_10m_pct,
        move_30m_pct = excluded.move_30m_pct,
        move_60m_pct = excluded.move_60m_pct,
        favorable_peak_60m_pct = excluded.favorable_peak_60m_pct,
        adverse_peak_60m_pct = excluded.adverse_peak_60m_pct,
        direction_correct_30m = excluded.direction_correct_30m,
        direction_correct_60m = excluded.direction_correct_60m,
        confidence_at_signal = excluded.confidence_at_signal,
        verification_score = excluded.verification_score,
        source = excluded.source,
        evaluated_at = datetime('now')
    `).run(
      outcome.signal_id,
      outcome.market,
      outcome.asset_id,
      outcome.asset_name,
      outcome.symbol,
      outcome.entry_time,
      outcome.entry_price,
      outcome.move_10m_pct,
      outcome.move_30m_pct,
      outcome.move_60m_pct,
      outcome.favorable_peak_60m_pct,
      outcome.adverse_peak_60m_pct,
      outcome.direction_correct_30m,
      outcome.direction_correct_60m,
      outcome.confidence_at_signal,
      outcome.verification_score,
      outcome.source
    );
  }

  private calculateSummary(date: string, market: 'swedish' | 'us') {
    const rows = this.db.prepare(`
      SELECT direction_correct_30m, direction_correct_60m, move_30m_pct, move_60m_pct
      FROM signal_outcomes
      WHERE market = ?
        AND date(entry_time) = ?
    `).all(market, date) as Array<{
      direction_correct_30m: number | null;
      direction_correct_60m: number | null;
      move_30m_pct: number | null;
      move_60m_pct: number | null;
    }>;

    if (rows.length === 0) {
      return {
        evaluated: 0,
        hitRate30m: 0,
        hitRate60m: 0,
        avgMove30m: 0,
        avgMove60m: 0
      };
    }

    const rate = (values: Array<number | null>) => {
      const valid = values.filter(v => v != null) as number[];
      if (valid.length === 0) return 0;
      return valid.reduce((sum, value) => sum + value, 0) / valid.length;
    };
    const avg = (values: Array<number | null>) => {
      const valid = values.filter(v => v != null) as number[];
      if (valid.length === 0) return 0;
      return valid.reduce((sum, value) => sum + value, 0) / valid.length;
    };

    return {
      evaluated: rows.length,
      hitRate30m: rate(rows.map(row => row.direction_correct_30m)),
      hitRate60m: rate(rows.map(row => row.direction_correct_60m)),
      avgMove30m: avg(rows.map(row => row.move_30m_pct)),
      avgMove60m: avg(rows.map(row => row.move_60m_pct))
    };
  }

  private calculateIndicatorBreakdowns(date: string, market: 'swedish' | 'us') {
    const rows = this.db.prepare(`
      SELECT
        COALESCE(so.direction_correct_30m, 0) as hit30,
        COALESCE(so.direction_correct_60m, 0) as hit60,
        LOWER(COALESCE(s.reasoning, '')) as reasoning
      FROM signal_outcomes so
      JOIN signals s ON s.id = so.signal_id
      WHERE so.market = ?
        AND date(so.entry_time) = ?
    `).all(market, date) as Array<{
      hit30: number;
      hit60: number;
      reasoning: string;
    }>;

    const summarize = (subset: Array<{ hit30: number; hit60: number }>) => {
      if (subset.length === 0) {
        return { count: 0, hitRate30m: 0, hitRate60m: 0 };
      }
      const hitRate30m = subset.reduce((sum, row) => sum + row.hit30, 0) / subset.length;
      const hitRate60m = subset.reduce((sum, row) => sum + row.hit60, 0) / subset.length;
      return { count: subset.length, hitRate30m, hitRate60m };
    };

    const withFutures = rows.filter(row => row.reasoning.includes('[futures:') && row.reasoning.includes('confirms'));
    const withoutFutures = rows.filter(row => !(row.reasoning.includes('[futures:') && row.reasoning.includes('confirms')));
    const withMacro = rows.filter(row => row.reasoning.includes('[macro:'));
    const withoutMacro = rows.filter(row => !row.reasoning.includes('[macro:'));

    const volatilityRegime: Record<string, { count: number; hitRate30m: number; hitRate60m: number }> = {
      high: summarize(rows.filter(row => row.reasoning.includes('[vol:high'))),
      low: summarize(rows.filter(row => row.reasoning.includes('[vol:low'))),
      normal: summarize(rows.filter(row => row.reasoning.includes('[vol:normal'))),
      extreme: summarize(rows.filter(row => row.reasoning.includes('[vol:extreme'))),
      unknown: summarize(rows.filter(row => !row.reasoning.includes('[vol:')))
    };

    return {
      futuresConfirmation: {
        withConfirmation: summarize(withFutures),
        withoutConfirmation: summarize(withoutFutures)
      },
      macroWindow: {
        withMacro: summarize(withMacro),
        withoutMacro: summarize(withoutMacro)
      },
      volatilityRegime
    };
  }

  private storeRunSummary(
    date: string,
    market: 'swedish' | 'us',
    summary: { evaluated: number; hitRate30m: number; hitRate60m: number; avgMove30m: number; avgMove60m: number },
    aiNotes: string,
    mode: BacktestCandidateMode,
    evaluatedCount: number
  ): void {
    this.db.prepare(`
      INSERT INTO daily_backtest_runs (
        date, market, candidate_mode, executed_at, signals_evaluated, hit_rate_30m, hit_rate_60m,
        avg_move_30m, avg_move_60m, ai_notes
      )
      VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, market) DO UPDATE SET
        candidate_mode = excluded.candidate_mode,
        executed_at = excluded.executed_at,
        signals_evaluated = excluded.signals_evaluated,
        hit_rate_30m = excluded.hit_rate_30m,
        hit_rate_60m = excluded.hit_rate_60m,
        avg_move_30m = excluded.avg_move_30m,
        avg_move_60m = excluded.avg_move_60m,
        ai_notes = excluded.ai_notes
    `).run(
      date,
      market,
      mode,
      evaluatedCount,
      summary.hitRate30m,
      summary.hitRate60m,
      summary.avgMove30m,
      summary.avgMove60m,
      aiNotes
    );
  }

  private refreshAssetPerformance(market: 'swedish' | 'us'): void {
    const rows = this.db.prepare(`
      SELECT
        asset_id,
        asset_name,
        COUNT(*) as samples,
        AVG(COALESCE(direction_correct_30m, 0)) as hit_rate_30m,
        AVG(COALESCE(direction_correct_60m, 0)) as hit_rate_60m,
        AVG(COALESCE(move_60m_pct, 0)) as avg_move_60m,
        AVG(COALESCE(favorable_peak_60m_pct, 0)) as avg_favorable_60m,
        AVG(COALESCE(adverse_peak_60m_pct, 0)) as avg_adverse_60m
      FROM signal_outcomes
      WHERE market = ?
        AND evaluated_at >= datetime('now', '-21 days')
      GROUP BY asset_id, asset_name
    `).all(market) as Array<{
      asset_id: string;
      asset_name: string;
      samples: number;
      hit_rate_30m: number;
      hit_rate_60m: number;
      avg_move_60m: number;
      avg_favorable_60m: number;
      avg_adverse_60m: number;
    }>;

    const upsert = this.db.prepare(`
      INSERT INTO asset_performance (
        asset_id, asset_name, market, samples, hit_rate_30m, hit_rate_60m,
        avg_move_60m, avg_favorable_60m, avg_adverse_60m,
        reliability_score, suggested_confidence_adjustment, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET
        asset_name = excluded.asset_name,
        market = excluded.market,
        samples = excluded.samples,
        hit_rate_30m = excluded.hit_rate_30m,
        hit_rate_60m = excluded.hit_rate_60m,
        avg_move_60m = excluded.avg_move_60m,
        avg_favorable_60m = excluded.avg_favorable_60m,
        avg_adverse_60m = excluded.avg_adverse_60m,
        reliability_score = excluded.reliability_score,
        suggested_confidence_adjustment = excluded.suggested_confidence_adjustment,
        updated_at = datetime('now')
    `);

    for (const row of rows) {
      const samples = row.samples || 0;
      const hitRate60 = row.hit_rate_60m || 0;
      const avgFav = row.avg_favorable_60m || 0;
      const avgAdv = row.avg_adverse_60m || 0;

      const reliability = samples < 4
        ? 0.5
        : clamp(0.25 + hitRate60 * 0.6 + clamp(avgFav / 2, 0, 0.2) + clamp(avgAdv / 2, -0.2, 0), 0, 1);

      const adjustment = samples < 4
        ? 0
        : clamp(Math.round((hitRate60 - 0.58) * 28 + (row.avg_move_60m > 0.4 ? 2 : -2)), -15, 12);

      upsert.run(
        row.asset_id,
        row.asset_name,
        market,
        samples,
        row.hit_rate_30m,
        row.hit_rate_60m,
        row.avg_move_60m,
        row.avg_favorable_60m,
        row.avg_adverse_60m,
        reliability,
        adjustment
      );
    }
  }

  private refreshPushPerformance(market: 'swedish' | 'us'): void {
    const rows = this.db.prepare(`
      SELECT
        asset_id,
        asset_name,
        COUNT(*) as samples,
        AVG(COALESCE(direction_correct_30m, 0)) as hit_rate_30m,
        AVG(COALESCE(direction_correct_60m, 0)) as hit_rate_60m,
        AVG(COALESCE(move_30m_pct, 0)) as avg_move_30m,
        AVG(COALESCE(move_60m_pct, 0)) as avg_move_60m
      FROM signal_outcomes
      WHERE market = ?
        AND source = 'push_timestamp'
        AND evaluated_at >= datetime('now', '-30 days')
      GROUP BY asset_id, asset_name
    `).all(market) as Array<{
      asset_id: string;
      asset_name: string;
      samples: number;
      hit_rate_30m: number;
      hit_rate_60m: number;
      avg_move_30m: number;
      avg_move_60m: number;
    }>;

    const upsert = this.db.prepare(`
      INSERT INTO asset_push_performance (
        asset_id, asset_name, market, samples, hit_rate_30m, hit_rate_60m,
        avg_move_30m, avg_move_60m, reliability_score, gate, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET
        asset_name = excluded.asset_name,
        market = excluded.market,
        samples = excluded.samples,
        hit_rate_30m = excluded.hit_rate_30m,
        hit_rate_60m = excluded.hit_rate_60m,
        avg_move_30m = excluded.avg_move_30m,
        avg_move_60m = excluded.avg_move_60m,
        reliability_score = excluded.reliability_score,
        gate = excluded.gate,
        updated_at = datetime('now')
    `);

    for (const row of rows) {
      const samples = row.samples || 0;
      const hit30 = row.hit_rate_30m || 0;
      const hit60 = row.hit_rate_60m || 0;
      const avg30 = row.avg_move_30m || 0;
      const avg60 = row.avg_move_60m || 0;
      const priorN = 8;
      const priorHit = 0.5;
      const smoothedHit30 = ((hit30 * samples) + (priorHit * priorN)) / Math.max(1, samples + priorN);
      const smoothedHit60 = ((hit60 * samples) + (priorHit * priorN)) / Math.max(1, samples + priorN);

      const reliability = samples < 4
        ? 0.5
        : clamp(
            0.2 +
            smoothedHit30 * 0.5 +
            smoothedHit60 * 0.2 +
            clamp(avg30 / 0.8, -0.2, 0.2) +
            clamp(avg60 / 1.2, -0.15, 0.25),
            0,
            1
          );

      let gate: 'open' | 'watch' | 'block' = 'watch';
      if (samples >= 8) {
        if (smoothedHit30 >= 0.58 && avg30 > 0.02) {
          gate = 'open';
        } else if (smoothedHit30 <= 0.45 && avg30 <= 0) {
          gate = 'block';
        }
      }

      upsert.run(
        row.asset_id,
        row.asset_name,
        market,
        samples,
        row.hit_rate_30m,
        row.hit_rate_60m,
        row.avg_move_30m,
        row.avg_move_60m,
        reliability,
        gate
      );
    }
  }

  private optimizePushPolicy(market: 'swedish' | 'us'): void {
    const minConfCandidates = [65, 68, 70, 72, 75, 78];
    const minDeltaCandidates = [15, 18, 22, 25, 30];

    let best: {
      minConfidence: number;
      minDeltaPct: number;
      objective: number;
      samples: number;
      hit30: number;
      move30: number;
      evidence: number;
    } | null = null;

    const query = this.db.prepare(`
      SELECT
        COUNT(*) as samples,
        AVG(COALESCE(so.direction_correct_30m, 0)) as hit30,
        AVG(COALESCE(so.move_30m_pct, 0)) as move30
      FROM signal_outcomes so
      JOIN signals s ON s.id = so.signal_id
      WHERE so.market = ?
        AND so.source = 'push_timestamp'
        AND so.evaluated_at >= datetime('now', '-30 days')
        AND s.verification_status = 'approved'
        AND s.confidence >= ?
        AND ABS(s.delta_pct) >= ?
        AND LOWER(s.market_title) NOT LIKE '%up or down%'
        AND LOWER(s.market_title) NOT LIKE '%podcast%'
        AND LOWER(s.market_title) NOT LIKE '%appear on%'
    `);

    for (const minConfidence of minConfCandidates) {
      for (const minDeltaPct of minDeltaCandidates) {
        const row = query.get(market, minConfidence, minDeltaPct) as {
          samples: number;
          hit30: number;
          move30: number;
        } | undefined;

        if (!row || (row.samples || 0) < 8) continue;

        const samples = row.samples || 0;
        const hit30 = row.hit30 || 0;
        const move30 = row.move30 || 0;
        const quality = ((hit30 - 0.5) * 1.5) + clamp(move30 / 0.25, -0.5, 0.5);
        const coverage = Math.min(samples / 40, 1);
        const objective = quality * 0.82 + coverage * 0.18;

        const evidence = hit30 >= 0.56
          ? 2
          : hit30 >= 0.48
            ? 3
            : 4;

        if (!best || objective > best.objective) {
          best = {
            minConfidence,
            minDeltaPct,
            objective,
            samples,
            hit30,
            move30,
            evidence
          };
        }
      }
    }

    const fallback = {
      minConfidence: 65,
      minDeltaPct: 15,
      minEvidenceScore: 3,
      objective: 0,
      samples: 0
    };

    const chosen = best
      ? {
          minConfidence: best.minConfidence,
          minDeltaPct: best.minDeltaPct,
          minEvidenceScore: best.evidence,
          objective: best.objective,
          samples: best.samples
        }
      : fallback;

    this.db.prepare(`
      INSERT INTO push_policy_config (
        market, min_confidence, min_delta_pct, min_evidence_score,
        optimization_score, sample_count, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(market) DO UPDATE SET
        min_confidence = excluded.min_confidence,
        min_delta_pct = excluded.min_delta_pct,
        min_evidence_score = excluded.min_evidence_score,
        optimization_score = excluded.optimization_score,
        sample_count = excluded.sample_count,
        updated_at = datetime('now')
    `).run(
      market,
      chosen.minConfidence,
      chosen.minDeltaPct,
      chosen.minEvidenceScore,
      chosen.objective,
      chosen.samples
    );
  }

  private async generateClaudeNotes(
    date: string,
    market: 'swedish' | 'us',
    summary: { evaluated: number; hitRate30m: number; hitRate60m: number; avgMove30m: number; avgMove60m: number }
  ): Promise<string> {
    if (summary.evaluated < 5) return '';

    const assetRows = this.db.prepare(`
      SELECT asset_id, asset_name, samples, hit_rate_60m, avg_move_60m, suggested_confidence_adjustment
      FROM asset_performance
      WHERE market = ?
      ORDER BY hit_rate_60m DESC, samples DESC
      LIMIT 12
    `).all(market) as Array<{
      asset_id: string;
      asset_name: string;
      samples: number;
      hit_rate_60m: number;
      avg_move_60m: number;
      suggested_confidence_adjustment: number;
    }>;

    const payload = {
      task: 'Summarize what improved/degraded and suggest one conservative tuning action for tomorrow.',
      constraints: 'Max 120 words, no markdown, no hype.',
      daily_summary: {
        date,
        market,
        evaluated_signals: summary.evaluated,
        hit_rate_30m: summary.hitRate30m,
        hit_rate_60m: summary.hitRate60m,
        avg_move_30m_pct: summary.avgMove30m,
        avg_move_60m_pct: summary.avgMove60m
      },
      asset_performance: assetRows
    };
    const prompt = `${JSON.stringify(payload, null, 2)}\nReturn plain text only.`;

    for (const binary of CLAUDE_CANDIDATES) {
      try {
        const { stdout } = await execFileAsync(binary, ['-p', prompt], { timeout: 30000 });
        const note = stdout.trim();
        if (note) return note.slice(0, 800);
      } catch {
        // Try next binary.
      }
    }
    return '';
  }
}
