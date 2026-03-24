import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { IntelligenceEngine, isBriefingCandidate } from './engine.js';

function createSignalsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE signals (
      id TEXT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      market_condition_id TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      market_title TEXT NOT NULL,
      odds_before REAL NOT NULL,
      odds_now REAL NOT NULL,
      delta_pct REAL NOT NULL,
      time_window_minutes INTEGER NOT NULL,
      whale_detected BOOLEAN DEFAULT FALSE,
      whale_amount_usd REAL,
      matched_asset_id TEXT NOT NULL,
      matched_asset_name TEXT NOT NULL,
      polarity TEXT NOT NULL,
      suggested_action TEXT NOT NULL,
      suggested_instruments TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      requires_judgment BOOLEAN DEFAULT FALSE,
      deduplication_key TEXT,
      ai_analysis TEXT,
      verification_status TEXT DEFAULT 'pending',
      verification_score INTEGER DEFAULT 0,
      verification_reason TEXT,
      verification_flags TEXT DEFAULT '[]',
      verification_source TEXT DEFAULT 'none',
      verification_record TEXT,
      verification_updated_at DATETIME,
      push_sent_at DATETIME,
      push_channel TEXT,
      status TEXT DEFAULT 'new'
    );

    CREATE TABLE daily_backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      market TEXT NOT NULL,
      candidate_mode TEXT DEFAULT 'push_only',
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      signals_evaluated INTEGER DEFAULT 0,
      hit_rate_30m REAL DEFAULT 0,
      hit_rate_60m REAL DEFAULT 0,
      avg_move_30m REAL DEFAULT 0,
      avg_move_60m REAL DEFAULT 0,
      ai_notes TEXT
    );
  `);
}

describe('IntelligenceEngine briefing gating', () => {
  it('treats weak guard-only signals as non-briefing candidates', () => {
    expect(isBriefingCandidate({
      confidence: 32,
      verification_source: 'guard',
      whale_detected: false,
      reasoning: 'Momentum only'
    })).toBe(false);
  });

  it('stays flat when only weak overnight signals exist', async () => {
    const db = new Database(':memory:');
    createSignalsTable(db);
    const engine = new IntelligenceEngine(db);

    db.prepare(`
      INSERT INTO signals (
        id, timestamp, market_condition_id, market_slug, market_title,
        odds_before, odds_now, delta_pct, time_window_minutes,
        whale_detected, whale_amount_usd, matched_asset_id, matched_asset_name,
        polarity, suggested_action, suggested_instruments, reasoning, confidence,
        requires_judgment, deduplication_key, verification_status, verification_score,
        verification_reason, verification_flags, verification_source, verification_record, status
      ) VALUES (
        'sig_evo_weak', datetime('now'), 'cond_evo', 'ohio-osb-license',
        'Will Ohio Revoke Any OSB License Over Event-Contract Activity by March 31?',
        0.2085, 0.2515, 20.62, 240,
        0, NULL, 'gaming-evolution', 'Evolution Gaming',
        'direct', 'Consider BULL position', '[]',
        'Weak guard-only signal', 32,
        0, 'cond_evo_gaming-evolution_bull', 'approved', 90,
        'Known entity-asset relationship validated', '[]', 'guard', NULL, 'new'
      )
    `).run();

    const briefing = await engine.generateMorningBriefing('swedish', 72);
    expect(briefing).toBe('No clear trades today — stay flat.');

    const stored = db.prepare(`SELECT briefing_text, top_signals FROM daily_briefing WHERE market = 'swedish'`).get() as {
      briefing_text: string;
      top_signals: string;
    };
    expect(stored.briefing_text).toBe('No clear trades today — stay flat.');
    expect(stored.top_signals).toBe('[]');
  });
});
