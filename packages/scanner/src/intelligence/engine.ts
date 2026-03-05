import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SWEDISH_MARKET_ASSETS, US_MARKET_ASSETS } from './trading-hours.js';

const execFileAsync = promisify(execFile);

interface IntelligenceMemoryRow {
  id: number;
  created_at: string;
  category: string;
  insight: string;
  affected_assets: string;
  confidence_boost: number;
  decay_days: number;
  source_signals: string;
  expires_at: string;
}

interface DailyBriefingRow {
  id: number;
  date: string;
  market: 'swedish' | 'us';
  briefing_generated_at: string | null;
  briefing_text: string | null;
  top_signals: string;
  pushed_at: string | null;
}

export class IntelligenceEngine {
  constructor(private db: Database.Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intelligence_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        category TEXT NOT NULL,
        insight TEXT NOT NULL,
        affected_assets TEXT NOT NULL,
        confidence_boost INTEGER DEFAULT 0,
        decay_days INTEGER DEFAULT 7,
        source_signals TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_briefing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        market TEXT NOT NULL,
        briefing_generated_at TEXT,
        briefing_text TEXT,
        top_signals TEXT NOT NULL DEFAULT '[]',
        pushed_at TEXT,
        UNIQUE(date, market)
      );

      CREATE TABLE IF NOT EXISTS signal_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL,
        related_signal_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        explanation TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * Process new signals: detect reinforcing patterns and link relationships.
   */
  processNewSignals(signals: Array<{ [key: string]: any }>): void {
    if (signals.length === 0) return;

    const assetGroups = new Map<string, Array<{ [key: string]: any }>>();
    for (const signal of signals) {
      const key = signal.matched_asset_id;
      if (!assetGroups.has(key)) {
        assetGroups.set(key, []);
      }
      assetGroups.get(key)!.push(signal);
    }

    for (const [assetId, group] of assetGroups) {
      if (group.length < 2) continue;

      const directions = group.map(signal =>
        signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear'
      );

      if (!directions.every(direction => direction === directions[0])) {
        continue;
      }

      const boost = Math.min(group.length * 5, 20);
      this.addMemory({
        category: assetId.split('-')[0] || 'unknown',
        insight: `${group.length} markets align ${directions[0].toUpperCase()} for ${group[0].matched_asset_name}`,
        affected_assets: [assetId],
        confidence_boost: boost,
        decay_days: 3,
        source_signals: group.map(signal => signal.id)
      });
    }

    const activeMemories = this.getActiveMemories();
    for (const signal of signals) {
      for (const memory of activeMemories) {
        const affectedAssets = this.safeJsonArray(memory.affected_assets);
        if (affectedAssets.includes(signal.matched_asset_id)) {
          this.addRelationship(signal.id, memory.source_signals, 'reinforces', memory.insight);
        }
      }
    }
  }

  getConfidenceBoost(assetId: string): number {
    const result = this.db.prepare(`
      SELECT COALESCE(SUM(confidence_boost), 0) as total_boost
      FROM intelligence_memory
      WHERE expires_at > datetime('now')
        AND affected_assets LIKE ?
    `).get(`%${assetId}%`) as { total_boost: number };

    return result.total_boost || 0;
  }

  getMorningBriefing(market: 'swedish' | 'us'): DailyBriefingRow | null {
    const today = this.getStockholmDateString();
    return this.db.prepare(
      `SELECT * FROM daily_briefing WHERE date = ? AND market = ?`
    ).get(today, market) as DailyBriefingRow | null;
  }

  /**
   * Generate market briefing using Claude CLI (with deterministic fallback).
   */
  async generateMorningBriefing(market: 'swedish' | 'us'): Promise<string> {
    const today = this.getStockholmDateString();
    const marketName = market === 'swedish' ? 'Stockholm OMX' : 'US NYSE/NASDAQ';
    const assetList = market === 'swedish' ? Array.from(SWEDISH_MARKET_ASSETS) : Array.from(US_MARKET_ASSETS);

    const placeholders = assetList.map(() => '?').join(',');
    const recentSignals = this.db.prepare(`
      SELECT * FROM signals
      WHERE timestamp >= datetime('now', '-16 hours')
        AND matched_asset_id IN (${placeholders})
        AND requires_judgment = 0
        AND verification_status = 'approved'
      ORDER BY confidence DESC
    `).all(...assetList) as Array<{ [key: string]: any }>;

    if (recentSignals.length === 0) {
      const fallback = 'No significant overnight signals.';
      this.storeBriefing(today, market, fallback, []);
      return fallback;
    }

    const topSignals = this.getTopSignalsByAsset(recentSignals, 5);
    const activeMemories = this.getActiveMemories().slice(0, 5);

    let tweetContext = '';
    try {
      const { TweetIntelligenceProcessor } = await import('../tweets/processor.js');
      const tweetProcessor = new TweetIntelligenceProcessor(this.db);
      tweetContext = tweetProcessor.getTweetContextForBriefing(16);
    } catch {
      // Optional module path; continue without tweet context.
    }

    const prompt = `You are a trading analyst. Write a pre-market briefing for ${marketName} open. Max 200 words.
For each signal state: ASSET -> DIRECTION -> WHY -> CONFIDENCE.

Overnight signals:
${topSignals.map(signal => `- ${signal.matched_asset_name}: ${signal.suggested_action} (${signal.confidence}%) - ${signal.market_title} - odds ${(signal.odds_before * 100).toFixed(0)}%->${(signal.odds_now * 100).toFixed(0)}%`).join('\n')}

Context:
${activeMemories.map(memory => `- ${memory.insight} (boost: +${memory.confidence_boost})`).join('\n') || 'None'}
${tweetContext}

Start with the single strongest trade idea. Be direct and concise.`;

    let briefingText = '';
    for (const binary of ['claude', 'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude.cmd']) {
      try {
        const { stdout } = await execFileAsync(binary, ['-p', prompt], { timeout: 60000 });
        briefingText = stdout.trim();
        if (briefingText) break;
      } catch {
        // Try next binary.
      }
    }

    if (!briefingText) {
      briefingText = topSignals.map((signal, index) => {
        const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'BULL' : 'BEAR';
        return `#${index + 1} ${direction} ${signal.matched_asset_name} (${signal.confidence}%) - ${signal.market_title.substring(0, 55)}`;
      }).join('\n');
    }

    this.storeBriefing(today, market, briefingText, topSignals);
    return briefingText;
  }

  markBriefingPushed(market: 'swedish' | 'us'): void {
    const today = this.getStockholmDateString();
    this.db.prepare(
      `UPDATE daily_briefing SET pushed_at = datetime('now') WHERE date = ? AND market = ?`
    ).run(today, market);
  }

  getActiveMemories(): IntelligenceMemoryRow[] {
    return this.db.prepare(`
      SELECT * FROM intelligence_memory
      WHERE expires_at > datetime('now')
      ORDER BY confidence_boost DESC
      LIMIT 20
    `).all() as IntelligenceMemoryRow[];
  }

  private getTopSignalsByAsset(signals: Array<{ [key: string]: any }>, limit: number): Array<{ [key: string]: any }> {
    const byAsset = new Map<string, { [key: string]: any }>();

    for (const signal of signals) {
      const existing = byAsset.get(signal.matched_asset_id);
      if (!existing || signal.confidence > existing.confidence) {
        byAsset.set(signal.matched_asset_id, signal);
      }
    }

    return Array.from(byAsset.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);
  }

  private addMemory(params: {
    category: string;
    insight: string;
    affected_assets: string[];
    confidence_boost: number;
    decay_days: number;
    source_signals: string[];
  }): void {
    this.db.prepare(`
      INSERT INTO intelligence_memory (
        category, insight, affected_assets, confidence_boost, decay_days, source_signals, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))
    `).run(
      params.category,
      params.insight,
      JSON.stringify(params.affected_assets),
      params.confidence_boost,
      params.decay_days,
      JSON.stringify(params.source_signals),
      params.decay_days
    );
  }

  private addRelationship(signalId: string, sourceSignalsJson: string, type: string, explanation: string): void {
    const sources = this.safeJsonArray(sourceSignalsJson);
    if (sources.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO signal_relationships (signal_id, related_signal_id, relationship_type, explanation)
      VALUES (?, ?, ?, ?)
    `);

    for (const relatedSignalId of sources) {
      if (relatedSignalId !== signalId) {
        stmt.run(signalId, relatedSignalId, type, explanation);
      }
    }
  }

  private storeBriefing(date: string, market: string, text: string, signals: Array<{ [key: string]: any }>): void {
    this.db.prepare(`
      INSERT INTO daily_briefing (date, market, briefing_generated_at, briefing_text, top_signals)
      VALUES (?, ?, datetime('now'), ?, ?)
      ON CONFLICT(date, market) DO UPDATE SET
        briefing_generated_at = excluded.briefing_generated_at,
        briefing_text = excluded.briefing_text,
        top_signals = excluded.top_signals
    `).run(date, market, text, JSON.stringify(signals));
  }

  private getStockholmDateString(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
  }

  private safeJsonArray(value: string): string[] {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
}
