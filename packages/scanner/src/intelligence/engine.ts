import Database from 'better-sqlite3';
import { SWEDISH_MARKET_ASSETS, US_MARKET_ASSETS } from './trading-hours.js';
import { NewsCorrelator } from './news-correlator.js';
import { runLocalAiPrompt } from '../utils/local-ai-cli.js';

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

const SECTOR_PEERS: Record<string, string[]> = {
  defense:    ['defense-rheinmetall', 'defense-saab', 'defense-bae', 'defense-lockheed'],
  energy:     ['oil-equinor', 'oil-conocophillips', 'oil-shell', 'oil-exxon'],
  technology: ['ai-nvidia', 'ai-palantir', 'ai-crowdstrike', 'tech-spotify'],
  mining:     ['mining-boliden', 'mining-freeport'],
  index:      ['sp500', 'nasdaq100', 'omx30'],
};

// Sector pairs that co-move due to shared macro drivers
const CROSS_SECTOR_PAIRS: [string, string][] = [
  ['defense', 'energy'],   // geopolitical conflict drives both
  ['defense', 'mining'],   // rearmament demand for metals
  ['energy', 'mining'],    // commodities co-move
];

function getSectorForAsset(assetId: string): string | null {
  for (const [sector, peers] of Object.entries(SECTOR_PEERS)) {
    if (peers.includes(assetId)) return sector;
  }
  return null;
}

export class IntelligenceEngine {
  private static readonly MAX_CONFIDENCE_BOOST = 25;

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
   * Boosts: +5/mkt same asset (max 20), +3/peer same sector (max 9), +2 cross-sector pair.
   */
  processNewSignals(signals: Array<{ [key: string]: any }>): void {
    if (signals.length === 0) return;

    const getDir = (s: { [key: string]: any }) =>
      s.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';

    // ── 1. Same-asset reinforcement (+5 per market, max 20) ─────────────────
    const assetGroups = new Map<string, Array<{ [key: string]: any }>>();
    for (const signal of signals) {
      const key = signal.matched_asset_id;
      if (!assetGroups.has(key)) assetGroups.set(key, []);
      assetGroups.get(key)!.push(signal);
    }

    for (const [assetId, group] of assetGroups) {
      if (group.length < 2) continue;
      const dirs = group.map(getDir);
      if (!dirs.every(d => d === dirs[0])) continue;

      const boost = Math.min(group.length * 5, 20);
      const insight = `${group.length} markets align ${dirs[0].toUpperCase()} for ${group[0].matched_asset_name}`;
      const existing = this.db.prepare(
        `SELECT id FROM intelligence_memory WHERE insight = ? AND expires_at > datetime('now') LIMIT 1`
      ).get(insight) as { id: number } | undefined;

      if (!existing) {
        this.addMemory({
          category: assetId.split('-')[0] || 'unknown',
          insight,
          affected_assets: [assetId],
          confidence_boost: boost,
          decay_days: 3,
          source_signals: group.map(s => s.id)
        });
      }
    }

    // ── 2. Same-sector reinforcement (+3 per peer signal, max 9) ────────────
    // Group signals by sector × direction, keeping only distinct assets.
    const sectorDirGroups = new Map<string, Array<{ [key: string]: any }>>();
    for (const signal of signals) {
      const sector = getSectorForAsset(signal.matched_asset_id);
      if (!sector) continue;
      const key = `${sector}:${getDir(signal)}`;
      if (!sectorDirGroups.has(key)) sectorDirGroups.set(key, []);
      const group = sectorDirGroups.get(key)!;
      // One representative signal per asset is enough.
      if (!group.some(s => s.matched_asset_id === signal.matched_asset_id)) {
        group.push(signal);
      }
    }

    for (const [key, group] of sectorDirGroups) {
      if (group.length < 2) continue; // need 2+ distinct assets in sector
      const [sector, dir] = key.split(':');
      const boost = Math.min((group.length - 1) * 3, 9);
      const affectedIds = SECTOR_PEERS[sector] ?? group.map(s => s.matched_asset_id);
      const insight = `${group.length} ${sector} assets align ${dir.toUpperCase()}`;
      const existing = this.db.prepare(
        `SELECT id FROM intelligence_memory WHERE insight = ? AND expires_at > datetime('now') LIMIT 1`
      ).get(insight) as { id: number } | undefined;

      if (!existing) {
        this.addMemory({
          category: sector,
          insight,
          affected_assets: affectedIds,
          confidence_boost: boost,
          decay_days: 2,
          source_signals: group.map(s => s.id)
        });
      }
    }

    // ── 3. Cross-sector reinforcement (+2 per pair) ──────────────────────────
    const activeSectors = new Map<string, string>(); // sector → direction
    for (const [key, group] of sectorDirGroups) {
      if (group.length === 0) continue;
      const [sector, dir] = key.split(':');
      // Only sectors with 1+ signal (not requiring 2 — macro drivers span any count)
      if (!activeSectors.has(sector)) activeSectors.set(sector, dir);
    }

    for (const [sectorA, sectorB] of CROSS_SECTOR_PAIRS) {
      const dirA = activeSectors.get(sectorA);
      const dirB = activeSectors.get(sectorB);
      if (!dirA || !dirB || dirA !== dirB) continue;

      const insight = `${sectorA}+${sectorB} cross-sector ${dirA.toUpperCase()} macro`;
      const existing = this.db.prepare(
        `SELECT id FROM intelligence_memory WHERE insight = ? AND expires_at > datetime('now') LIMIT 1`
      ).get(insight) as { id: number } | undefined;
      if (existing) continue;

      const affected = [
        ...(SECTOR_PEERS[sectorA] ?? []),
        ...(SECTOR_PEERS[sectorB] ?? [])
      ];
      const sourceSignals = signals
        .filter(s => {
          const sec = getSectorForAsset(s.matched_asset_id);
          return sec === sectorA || sec === sectorB;
        })
        .map(s => s.id);

      this.addMemory({
        category: `${sectorA}-${sectorB}`,
        insight,
        affected_assets: affected,
        confidence_boost: 2,
        decay_days: 2,
        source_signals: sourceSignals
      });
    }

    // ── 4. Link signals to active memories ──────────────────────────────────
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

    return Math.min(result.total_boost || 0, IntelligenceEngine.MAX_CONFIDENCE_BOOST);
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
    const activeMemories = this.getActiveMemories().slice(0, 8);
    const crossSectorMemories = activeMemories.filter(m => m.category.includes('-'));
    const reinforcingMemories = activeMemories.filter(m => !m.category.includes('-')).slice(0, 5);

    let tweetContext = '';
    try {
      const { TweetIntelligenceProcessor } = await import('../tweets/processor.js');
      const tweetProcessor = new TweetIntelligenceProcessor(this.db);
      tweetContext = tweetProcessor.getTweetContextForBriefing(16);
    } catch {
      // Optional module path; continue without tweet context.
    }

    // News reinforcement counts per top signal.
    const newsCorrelator = new NewsCorrelator(this.db);
    let totalNewsReinforced = 0;
    const signalItems = topSignals.map((signal, idx) => {
      const nb = newsCorrelator.getBoostForAsset(signal.matched_asset_id, 16);
      if (nb.sourceCount >= 2) totalNewsReinforced++;
      const reasoning: string = signal.reasoning || '';
      const reasoningTags = (reasoning.match(/\[[^\]]+\]/g) ?? []).slice(0, 6).join(' ');
      return {
        index: idx,
        id: signal.id,
        asset: signal.matched_asset_name,
        action: signal.suggested_action,
        confidence: signal.confidence,
        market: (signal.market_title as string).substring(0, 80),
        odds_before: (signal.odds_before * 100).toFixed(0) + '%',
        odds_now: (signal.odds_now * 100).toFixed(0) + '%',
        delta_pct: signal.delta_pct,
        whale: signal.whale_detected ? `$${(signal.whale_amount_usd || 0).toLocaleString()}` : null,
        news_sources: nb.sourceCount >= 2 ? nb.sourceCount : 0,
        tags: reasoningTags || null
      };
    });

    // Fetch yesterday's backtest summary for this market.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDate = yesterday.toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' });
    const backtestRow = this.db.prepare(`
      SELECT signals_evaluated, hit_rate_30m, hit_rate_60m, avg_move_30m, ai_notes
      FROM daily_backtest_runs WHERE date = ? AND market = ? LIMIT 1
    `).get(yDate, market) as {
      signals_evaluated: number; hit_rate_30m: number; hit_rate_60m: number;
      avg_move_30m: number; ai_notes: string | null;
    } | undefined;

    const backtestSummary = backtestRow
      ? `${yDate}: ${backtestRow.signals_evaluated} signals evaluated, ` +
        `hit rate 30m=${(backtestRow.hit_rate_30m * 100).toFixed(0)}% ` +
        `60m=${(backtestRow.hit_rate_60m * 100).toFixed(0)}%, ` +
        `avg move=${backtestRow.avg_move_30m?.toFixed(1) ?? '?'}%. ` +
        (backtestRow.ai_notes ? backtestRow.ai_notes.slice(0, 150) : '')
      : 'No backtest data for yesterday.';

    const cetTime = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' });
    const openInMin = market === 'swedish' ? 15 : 15; // approximate until open

    const prompt = `You are the morning pre-market analyst for a Swedish trader on Avanza trading leveraged certificates (BULL/BEAR X3-X10). It is ${cetTime} CET, ${marketName} opens in ~${openInMin} minutes.

OVERNIGHT SIGNALS (${topSignals.length} top, sorted by confidence):
${JSON.stringify(signalItems, null, 2)}

News reinforcement: ${totalNewsReinforced} of ${topSignals.length} signals confirmed by 2+ independent news sources.

OVERNIGHT NEWS (from financial RSS feeds):
${tweetContext || 'No news context available.'}

YESTERDAY'S PERFORMANCE:
${backtestSummary}

ACTIVE REINFORCING PATTERNS:
${reinforcingMemories.map(m => `- ${m.insight} (+${m.confidence_boost})`).join('\n') || 'None'}

CROSS-SECTOR MACRO PATTERNS:
${crossSectorMemories.map(m => `- ${m.insight} (+${m.confidence_boost})`).join('\n') || 'None'}

TASK: Perform THREE steps in ONE response. Respond with ONLY valid JSON, no markdown fences.

{
  "ranked_signals": [
    {
      "signal_id": "<id from input>",
      "rank": 1,
      "verdict": "trade",
      "certificate": "BULL EQUINOR X3 AVA",
      "reason": "Qatar LNG restart + crude futures confirm + 3 news sources",
      "hold_minutes": 30
    }
  ],
  "briefing_text": "1-2 paragraph morning brief. Mention specific Avanza certificate names. Be brutally honest — weak setups get NO recommendation.",
  "market_outlook": "bullish|bearish|neutral",
  "stay_flat": false
}

Rules:
- CRITICAL: If no signal has strong conviction, set stay_flat=true and briefing_text="No clear trades today — stay flat." Do NOT force trades.
- verdict must be "trade" or "skip"
- certificate must be a real Avanza instrument name (e.g. "BULL EQUINOR X3 AVA", "BEAR NVIDIA X3 AVA")
- Weight signals higher if whale activity detected or news_sources >= 2
- Reject signals with contradicting futures/vol tags`;

    let briefingText = '';
    const aiResult = await runLocalAiPrompt(prompt, {
      timeoutMs: 90000,
      maxBufferBytes: 2 * 1024 * 1024,
      usageContext: 'morning-briefing',
      logContext: 'morning-briefing'
    });
    if (aiResult.ok) {
      try {
        const cleaned = aiResult.stdout.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.briefing_text) {
          briefingText = parsed.stay_flat
            ? parsed.briefing_text
            : parsed.briefing_text;
          // Store ranked signal verdicts back to DB for dashboard display
          if (Array.isArray(parsed.ranked_signals)) {
            for (const rs of parsed.ranked_signals) {
              if (rs.signal_id && rs.verdict) {
                try {
                  this.db.prepare(
                    `UPDATE signals SET ai_analysis = ? WHERE id = ?`
                  ).run(
                    `[${rs.verdict.toUpperCase()}] ${rs.certificate || ''} — ${rs.reason || ''} (hold ${rs.hold_minutes || '?'}min)`,
                    rs.signal_id
                  );
                } catch { /* non-fatal */ }
              }
            }
          }
        }
      } catch {
        // JSON parse failed — fall back to raw text
        briefingText = aiResult.stdout;
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
