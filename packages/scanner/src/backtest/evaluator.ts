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
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getStockholmDateString(date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
}

function isStockholmDate(dateIso: string, stockholmDate: string): boolean {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return false;
  return getStockholmDateString(date) === stockholmDate;
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
    force = false
  ): Promise<BacktestRunResult> {
    const alreadyRan = force ? undefined : this.db.prepare(`
      SELECT signals_evaluated, hit_rate_30m, hit_rate_60m, avg_move_30m, avg_move_60m, ai_notes
      FROM daily_backtest_runs
      WHERE date = ? AND market = ?
      LIMIT 1
    `).get(date, market) as {
      signals_evaluated: number;
      hit_rate_30m: number;
      hit_rate_60m: number;
      avg_move_30m: number;
      avg_move_60m: number;
      ai_notes: string | null;
    } | undefined;

    if (alreadyRan) {
      return {
        date,
        market,
        signalsEvaluated: alreadyRan.signals_evaluated || 0,
        hitRate30m: alreadyRan.hit_rate_30m || 0,
        hitRate60m: alreadyRan.hit_rate_60m || 0,
        avgMove30m: alreadyRan.avg_move_30m || 0,
        avgMove60m: alreadyRan.avg_move_60m || 0,
        aiNotes: alreadyRan.ai_notes || '',
        skipped: true
      };
    }

    // Bug A: If no signals for today yet (early morning or new filters), fall back to yesterday.
    let candidates = this.getCandidatesForDate(market, date);
    if (candidates.length === 0 && date === getStockholmDateString()) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yDate = getStockholmDateString(yesterday);
      const yCandidates = this.getCandidatesForDate(market, yDate);
      if (yCandidates.length > 0) {
        date = yDate;
        candidates = yCandidates;
        console.log(`[backtest] No signals for today, falling back to yesterday (${yDate})`);
      }
    }

    const nowMs = Date.now();
    let evaluated = 0;

    for (const signal of candidates) {
      const symbol = getYahooSymbol(signal.matched_asset_id);
      if (!symbol) continue;

      const entryIso = signal.push_sent_at || signal.timestamp;
      const entryMs = new Date(entryIso).getTime();
      if (!Number.isFinite(entryMs)) continue;

      // Need at least 30 minutes elapsed to evaluate short-term reaction.
      if (nowMs - entryMs < 30 * 60 * 1000) continue;

      const endMs = Math.min(entryMs + 60 * 60 * 1000, nowMs);
      const points = await this.priceClient.getSeries(symbol, entryMs, endMs);
      if (points.length < 3) continue;

      const entryPoint = pickPoint(points, entryMs);
      if (!entryPoint || entryPoint.close <= 0) continue;

      const isBull = signal.suggested_action.toLowerCase().includes('bull');
      const move10 = this.computeMove(points, entryPoint.close, entryMs, 10, isBull);
      const move30 = this.computeMove(points, entryPoint.close, entryMs, 30, isBull);
      const move60 = this.computeMove(points, entryPoint.close, entryMs, 60, isBull);

      const directionalSeries = points
        .filter(point => point.timestampMs >= entryMs && point.close > 0)
        .map(point => directionalMovePct(entryPoint.close, point.close, isBull));

      if (directionalSeries.length === 0) continue;

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
    const aiNotes = await this.generateClaudeNotes(date, market, summary);
    this.storeRunSummary(date, market, summary, aiNotes);
    this.refreshAssetPerformance(market);

    return {
      date,
      market,
      signalsEvaluated: evaluated,
      hitRate30m: summary.hitRate30m,
      hitRate60m: summary.hitRate60m,
      avgMove30m: summary.avgMove30m,
      avgMove60m: summary.avgMove60m,
      aiNotes,
      skipped: false
    };
  }

  private getCandidatesForDate(market: 'swedish' | 'us', date: string): SignalCandidate[] {
    const assetIds = market === 'swedish'
      ? Array.from(SWEDISH_MARKET_ASSETS)
      : Array.from(US_MARKET_ASSETS);
    const placeholders = assetIds.map(() => '?').join(',');

    const rows = this.db.prepare(`
      SELECT id, timestamp, push_sent_at, market_title, matched_asset_id, matched_asset_name,
             suggested_action, confidence, verification_score
      FROM signals
      WHERE matched_asset_id IN (${placeholders})
        AND verification_status IN ('approved', 'needs_review')
        AND requires_judgment = 0
        AND timestamp >= datetime('now', '-8 days')
        AND (push_sent_at IS NOT NULL OR confidence >= 40)
      ORDER BY confidence DESC, timestamp ASC
      LIMIT 220
    `).all(...assetIds) as SignalCandidate[];

    return rows
      .filter(row => isStockholmDate(row.timestamp, date))
      .slice(0, 120);
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

  private storeRunSummary(
    date: string,
    market: 'swedish' | 'us',
    summary: { evaluated: number; hitRate30m: number; hitRate60m: number; avgMove30m: number; avgMove60m: number },
    aiNotes: string
  ): void {
    this.db.prepare(`
      INSERT INTO daily_backtest_runs (
        date, market, executed_at, signals_evaluated, hit_rate_30m, hit_rate_60m,
        avg_move_30m, avg_move_60m, ai_notes
      )
      VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, market) DO UPDATE SET
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
      summary.evaluated,
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
