import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database path: project_root/data/polysignal.db
const DB_PATH = join(__dirname, '../../../../data/polysignal.db');

export function initializeDatabase(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables(db);
  return db;
}

function createTables(db: Database.Database): void {
  // Avanza instruments (certificates) registry
  db.exec(`
    CREATE TABLE IF NOT EXISTS instruments (
      id TEXT PRIMARY KEY,
      avanza_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('bull', 'bear')),
      underlying TEXT NOT NULL,
      leverage INTEGER,
      issuer TEXT,
      instrument_url TEXT,
      is_active BOOLEAN DEFAULT TRUE,
      last_verified_at DATETIME,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      delisted_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_instruments_underlying
    ON instruments(underlying, direction, is_active);

    CREATE INDEX IF NOT EXISTS idx_instruments_active
    ON instruments(is_active) WHERE is_active = TRUE;
  `);

  // Tracked Polymarket markets
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_id TEXT UNIQUE NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT,
      matched_asset_ids TEXT,
      relevance_score REAL,
      is_active BOOLEAN DEFAULT TRUE,
      volume REAL,
      liquidity REAL,
      discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      last_checked_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_markets_condition
    ON tracked_markets(condition_id);

    CREATE INDEX IF NOT EXISTS idx_markets_active
    ON tracked_markets(is_active) WHERE is_active = TRUE;
  `);

  // Odds snapshots (historical odds tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_condition_id TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      odds_yes REAL NOT NULL,
      odds_no REAL NOT NULL,
      volume_24h REAL,
      FOREIGN KEY (market_condition_id) REFERENCES tracked_markets(condition_id)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_market_time
    ON odds_snapshots(market_condition_id, timestamp DESC);
  `);

  // Whale events (large trades detected)
  db.exec(`
    CREATE TABLE IF NOT EXISTS whale_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_condition_id TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('YES', 'NO')),
      size_usd REAL NOT NULL,
      price_at_trade REAL,
      odds_impact REAL,
      FOREIGN KEY (market_condition_id) REFERENCES tracked_markets(condition_id)
    );

    CREATE INDEX IF NOT EXISTS idx_whales_market
    ON whale_events(market_condition_id, timestamp DESC);
  `);

  // Generated trade signals
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
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
      polarity TEXT NOT NULL CHECK(polarity IN ('direct', 'inverse')),
      suggested_action TEXT NOT NULL,
      suggested_instruments TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      status TEXT DEFAULT 'new' CHECK(status IN ('new', 'viewed', 'dismissed', 'acted')),
      FOREIGN KEY (market_condition_id) REFERENCES tracked_markets(condition_id)
    );

    CREATE INDEX IF NOT EXISTS idx_signals_timestamp
    ON signals(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_signals_status
    ON signals(status) WHERE status = 'new';
  `);

  // Job execution log (for monitoring scheduled jobs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
      error_message TEXT,
      results_summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_name_time
    ON job_executions(job_name, started_at DESC);
  `);

  console.log('Database initialized successfully at:', DB_PATH);
}

export function getDatabase(): Database.Database {
  return new Database(DB_PATH);
}
