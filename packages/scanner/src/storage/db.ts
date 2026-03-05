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
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('journal_size_limit = 67108864'); // 64MB WAL cap

  createTables(db);
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  const tableInfo = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='signals'`
  ).get() as { sql: string } | undefined;

  if (tableInfo?.sql && !tableInfo.sql.includes('context_dependent')) {
    db.exec(`
      ALTER TABLE signals RENAME TO signals_old;

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
        polarity TEXT NOT NULL CHECK(polarity IN ('direct', 'inverse', 'context_dependent')),
        suggested_action TEXT NOT NULL,
        suggested_instruments TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        requires_judgment BOOLEAN DEFAULT FALSE,
        deduplication_key TEXT,
        status TEXT DEFAULT 'new' CHECK(status IN ('new', 'viewed', 'dismissed', 'acted'))
      );

      INSERT INTO signals (
        id, timestamp, market_condition_id, market_slug, market_title,
        odds_before, odds_now, delta_pct, time_window_minutes,
        whale_detected, whale_amount_usd, matched_asset_id, matched_asset_name,
        polarity, suggested_action, suggested_instruments, reasoning, confidence, status
      )
      SELECT
        id, timestamp, market_condition_id, market_slug, market_title,
        odds_before, odds_now, delta_pct, time_window_minutes,
        whale_detected, whale_amount_usd, matched_asset_id, matched_asset_name,
        polarity, suggested_action, suggested_instruments, reasoning, confidence, status
      FROM signals_old;

      DROP TABLE signals_old;

      CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status) WHERE status = 'new';
      CREATE INDEX IF NOT EXISTS idx_signals_dedup ON signals(deduplication_key, timestamp DESC);
    `);
  }

  for (const sql of [
    `ALTER TABLE signals ADD COLUMN requires_judgment BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE signals ADD COLUMN deduplication_key TEXT`,
    `ALTER TABLE signals ADD COLUMN ai_analysis TEXT`,
    `ALTER TABLE whale_events ADD COLUMN trade_id TEXT`,
    `ALTER TABLE tracked_markets ADD COLUMN gamma_id TEXT`,

    // Tweet account enrichment
    `ALTER TABLE tweet_accounts ADD COLUMN discovery_source TEXT DEFAULT 'seed'`,
    `ALTER TABLE tweet_accounts ADD COLUMN causality_score REAL DEFAULT 0.35`,
    `ALTER TABLE tweet_accounts ADD COLUMN causal_tags TEXT DEFAULT '[]'`,
    `ALTER TABLE tweet_accounts ADD COLUMN causal_thesis TEXT`,
    `ALTER TABLE tweet_accounts ADD COLUMN discovery_depth INTEGER DEFAULT 0`,
    `ALTER TABLE tweet_accounts ADD COLUMN collect_enabled BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE tweet_accounts ADD COLUMN last_collected_at DATETIME`,
    `ALTER TABLE tweet_accounts ADD COLUMN feed_url TEXT`,
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists.
    }
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_dedup ON signals(deduplication_key, timestamp DESC)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_trade_id ON whale_events(trade_id) WHERE trade_id IS NOT NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_events_dedup ON whale_events(market_condition_id, trade_id) WHERE trade_id IS NOT NULL`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS tweet_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        handle TEXT UNIQUE NOT NULL,
        display_name TEXT,
        category TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        is_active BOOLEAN DEFAULT TRUE,
        discovery_source TEXT DEFAULT 'seed',
        causality_score REAL DEFAULT 0.35,
        causal_tags TEXT DEFAULT '[]',
        causal_thesis TEXT,
        discovery_depth INTEGER DEFAULT 0,
        collect_enabled BOOLEAN DEFAULT TRUE,
        last_scraped_at DATETIME,
        last_collected_at DATETIME,
        scrape_failures INTEGER DEFAULT 0,
        feed_url TEXT
      );

      CREATE TABLE IF NOT EXISTS tweet_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_handle TEXT NOT NULL,
        tweet_id TEXT UNIQUE,
        tweet_text TEXT NOT NULL,
        tweet_url TEXT,
        posted_at DATETIME,
        scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        likes INTEGER DEFAULT 0,
        retweets INTEGER DEFAULT 0,
        replies INTEGER DEFAULT 0,
        matched_asset_ids TEXT,
        sentiment TEXT CHECK(sentiment IN ('bullish', 'bearish', 'neutral', 'mixed')),
        ai_processed BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (account_handle) REFERENCES tweet_accounts(handle)
      );

      CREATE TABLE IF NOT EXISTS tweet_account_connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_handle TEXT NOT NULL,
        target_handle TEXT NOT NULL,
        connection_type TEXT NOT NULL,
        evidence_text TEXT,
        weight REAL DEFAULT 1.0,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_handle, target_handle, connection_type)
      );

      CREATE INDEX IF NOT EXISTS idx_tweet_accounts_collect
      ON tweet_accounts(collect_enabled, causality_score DESC, last_collected_at ASC);

      CREATE INDEX IF NOT EXISTS idx_tweet_accounts_source
      ON tweet_accounts(discovery_source, causality_score DESC);

      CREATE INDEX IF NOT EXISTS idx_tweet_snapshots_scraped
      ON tweet_snapshots(scraped_at DESC);

      CREATE INDEX IF NOT EXISTS idx_tweet_snapshots_unprocessed
      ON tweet_snapshots(ai_processed) WHERE ai_processed = FALSE;

      CREATE INDEX IF NOT EXISTS idx_tweet_connections_target
      ON tweet_account_connections(target_handle, last_seen_at DESC);
    `);
  } catch {
    // Tables/indexes already exist.
  }
}

function createTables(db: Database.Database): void {
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS whale_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_condition_id TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('YES', 'NO')),
      size_usd REAL NOT NULL,
      price_at_trade REAL,
      odds_impact REAL,
      trade_id TEXT,
      FOREIGN KEY (market_condition_id) REFERENCES tracked_markets(condition_id)
    );

    CREATE INDEX IF NOT EXISTS idx_whales_market
    ON whale_events(market_condition_id, timestamp DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_trade_id
    ON whale_events(trade_id) WHERE trade_id IS NOT NULL;
  `);

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
      polarity TEXT NOT NULL CHECK(polarity IN ('direct', 'inverse', 'context_dependent')),
      suggested_action TEXT NOT NULL,
      suggested_instruments TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      requires_judgment BOOLEAN DEFAULT FALSE,
      deduplication_key TEXT,
      status TEXT DEFAULT 'new' CHECK(status IN ('new', 'viewed', 'dismissed', 'acted')),
      FOREIGN KEY (market_condition_id) REFERENCES tracked_markets(condition_id)
    );

    CREATE INDEX IF NOT EXISTS idx_signals_timestamp
    ON signals(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_signals_status
    ON signals(status) WHERE status = 'new';

    CREATE INDEX IF NOT EXISTS idx_signals_dedup
    ON signals(deduplication_key, timestamp DESC);
  `);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS tweet_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handle TEXT UNIQUE NOT NULL,
      display_name TEXT,
      category TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      is_active BOOLEAN DEFAULT TRUE,
      discovery_source TEXT DEFAULT 'seed',
      causality_score REAL DEFAULT 0.35,
      causal_tags TEXT DEFAULT '[]',
      causal_thesis TEXT,
      discovery_depth INTEGER DEFAULT 0,
      collect_enabled BOOLEAN DEFAULT TRUE,
      last_scraped_at DATETIME,
      last_collected_at DATETIME,
      scrape_failures INTEGER DEFAULT 0,
      feed_url TEXT
    );

    CREATE TABLE IF NOT EXISTS tweet_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_handle TEXT NOT NULL,
      tweet_id TEXT UNIQUE,
      tweet_text TEXT NOT NULL,
      tweet_url TEXT,
      posted_at DATETIME,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      likes INTEGER DEFAULT 0,
      retweets INTEGER DEFAULT 0,
      replies INTEGER DEFAULT 0,
      matched_asset_ids TEXT,
      sentiment TEXT CHECK(sentiment IN ('bullish', 'bearish', 'neutral', 'mixed')),
      ai_processed BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (account_handle) REFERENCES tweet_accounts(handle)
    );

    CREATE TABLE IF NOT EXISTS tweet_account_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_handle TEXT NOT NULL,
      target_handle TEXT NOT NULL,
      connection_type TEXT NOT NULL,
      evidence_text TEXT,
      weight REAL DEFAULT 1.0,
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_handle, target_handle, connection_type)
    );


    CREATE INDEX IF NOT EXISTS idx_tweet_snapshots_scraped
    ON tweet_snapshots(scraped_at DESC);

    CREATE INDEX IF NOT EXISTS idx_tweet_snapshots_account
    ON tweet_snapshots(account_handle, scraped_at DESC);

    CREATE INDEX IF NOT EXISTS idx_tweet_snapshots_unprocessed
    ON tweet_snapshots(ai_processed) WHERE ai_processed = FALSE;

    CREATE INDEX IF NOT EXISTS idx_tweet_connections_target
    ON tweet_account_connections(target_handle, last_seen_at DESC);
  `);

  console.log('Database initialized successfully at:', DB_PATH);
}

export function getDatabase(): Database.Database {
  return new Database(DB_PATH);
}


