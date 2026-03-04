import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAssetMarket, SWEDISH_MARKET_ASSETS, US_MARKET_ASSETS } from './trading-hours.js';

const execFileAsync = promisify(execFile);

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
   * Process new signals — detect reinforcing patterns, link to existing memory,
   * accumulate for daily briefing.
   */
  processNewSignals(signals: any[]): void {
    if (signals.length === 0) return;

    // Find assets with multiple independent markets pointing the same direction
    const assetGroups = new Map<string, any[]>();
    for (const s of signals) {
      const key = s.matched_asset_id;
      if (!assetGroups.has(key)) assetGroups.set(key, []);
      assetGroups.get(key)!.push(s);
    }

    for (const [assetId, group] of assetGroups) {
      if (group.length < 2) continue;
      const directions = group.map((s: any) =>
        s.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear'
      );
      const allSameDir = directions.every((d: string) => d === directions[0]);
      if (!allSameDir) continue;

      const boost = Math.min(group.length * 5, 20);
      this.addMemory({
        category: assetId.split('-')[0] || 'unknown',
        insight: `${group.length} markets all point ${directions[0].toUpperCase()} for ${group[0].matched_asset_name}`,
        affected_assets: [assetId],
        confidence_boost: boost,
        decay_days: 3,
        source_signals: group.map((s: any) => s.id)
      });
    }

    // Check active memory for assets in new signals
    const activeMemories = this.getActiveMemories();
    for (const signal of signals) {
      for (const memory of activeMemories) {
        const affected: string[] = JSON.parse(memory.affected_assets);
        if (affected.includes(signal.matched_asset_id)) {
          this.addRelationship(signal.id, memory.source_signals, 'reinforces', memory.insight);
        }
      }
    }
  }

  /**
   * Get confidence boost for an asset from accumulated intelligence
   */
  getConfidenceBoost(assetId: string): number {
    const result = this.db.prepare(`
      SELECT COALESCE(SUM(confidence_boost), 0) as total_boost
      FROM intelligence_memory
      WHERE expires_at > datetime('now')
        AND affected_assets LIKE ?
    `).get(`%${assetId}%`) as { total_boost: number };
    return result.total_boost || 0;
  }

  /**
   * Get today's morning briefing for a market
   */
  getMorningBriefing(market: 'swedish' | 'us'): any | null {
    const today = new Date().toISOString().split('T')[0];
    return this.db.prepare(`
      SELECT * FROM daily_briefing WHERE date = ? AND market = ?
    `).get(today, market) || null;
  }

  /**
   * Generate a morning briefing using Claude CLI (with text fallback)
   */
  async generateMorningBriefing(market: 'swedish' | 'us'): Promise<string> {
    const today = new Date().toISOString().split('T')[0];
    const assetList = market === 'swedish'
      ? Array.from(SWEDISH_MARKET_ASSETS)
      : Array.from(US_MARKET_ASSETS);

    const placeholders = assetList.map(() => '?').join(',');
    const recentSignals: any[] = this.db.prepare(`
      SELECT * FROM signals
      WHERE timestamp >= datetime('now', '-16 hours')
        AND matched_asset_id IN (${placeholders})
        AND requires_judgment = 0
      ORDER BY confidence DESC
    `).all(...assetList);

    if (recentSignals.length === 0) {
      const fallback = 'No significant overnight signals.';
      this.storeBriefing(today, market, fallback, []);
      return fallback;
    }

    // Best signal per asset
    const byAsset = new Map<string, any>();
    for (const s of recentSignals) {
      const existing = byAsset.get(s.matched_asset_id);
      if (!existing || s.confidence > existing.confidence) byAsset.set(s.matched_asset_id, s);
    }
    const topSignals = Array.from(byAsset.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);

    const activeMemories = this.getActiveMemories().slice(0, 5);
    const marketName = market === 'swedish' ? 'Stockholm OMX' : 'US NYSE/NASDAQ';

    const prompt = `You are a trading analyst. Write a pre-market briefing for ${marketName} open. Max 200 words. For each signal state: ASSET → DIRECTION → WHY → CONFIDENCE.

Overnight signals:
${topSignals.map((s: any) => `- ${s.matched_asset_name}: ${s.suggested_action} (${s.confidence}%) — ${s.market_title} — odds ${(s.odds_before*100).toFixed(0)}%→${(s.odds_now*100).toFixed(0)}%`).join('\n')}

Context:
${activeMemories.map((m: any) => `- ${m.insight} (boost: +${m.confidence_boost})`).join('\n') || 'None'}

Start with the single strongest trade idea. Be direct and punchy.`;

    let briefingText = '';
    for (const bin of ['claude', 'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude.cmd']) {
      try {
        const { stdout } = await execFileAsync(bin, ['-p', prompt], { timeout: 60000 });
        briefingText = stdout.trim();
        break;
      } catch { /* try next */ }
    }

    if (!briefingText) {
      // Text fallback
      briefingText = topSignals.map((s: any, i: number) => {
        const dir = s.suggested_action.toLowerCase().includes('bull') ? 'BULL' : 'BEAR';
        return `#${i+1} ${dir} ${s.matched_asset_name} (${s.confidence}%) — ${s.market_title.substring(0, 55)}`;
      }).join('\n');
    }

    this.storeBriefing(today, market, briefingText, topSignals);
    return briefingText;
  }

  markBriefingPushed(market: 'swedish' | 'us'): void {
    const today = new Date().toISOString().split('T')[0];
    this.db.prepare(`
      UPDATE daily_briefing SET pushed_at = datetime('now') WHERE date = ? AND market = ?
    `).run(today, market);
  }

  getActiveMemories(): any[] {
    return this.db.prepare(`
      SELECT * FROM intelligence_memory
      WHERE expires_at > datetime('now')
      ORDER BY confidence_boost DESC
      LIMIT 20
    `).all();
  }

  // --- Private helpers ---

  private addMemory(params: {
    category: string;
    insight: string;
    affected_assets: string[];
    confidence_boost: number;
    decay_days: number;
    source_signals: string[];
  }): void {
    this.db.prepare(`
      INSERT INTO intelligence_memory (category, insight, affected_assets, confidence_boost, decay_days, source_signals, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))
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
    let sources: string[];
    try { sources = JSON.parse(sourceSignalsJson); } catch { return; }
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO signal_relationships (signal_id, related_signal_id, relationship_type, explanation)
      VALUES (?, ?, ?, ?)
    `);
    for (const related of sources) {
      if (related !== signalId) stmt.run(signalId, related, type, explanation);
    }
  }

  private storeBriefing(date: string, market: string, text: string, signals: any[]): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO daily_briefing (date, market, briefing_generated_at, briefing_text, top_signals)
      VALUES (?, ?, datetime('now'), ?, ?)
    `).run(date, market, text, JSON.stringify(signals));
  }
}
