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
        ai_analysis TEXT,
        verification_status TEXT DEFAULT 'pending' CHECK(verification_status IN ('pending', 'approved', 'rejected', 'needs_review')),
        verification_score INTEGER DEFAULT 0,
        verification_reason TEXT,
        verification_flags TEXT DEFAULT '[]',
        verification_source TEXT DEFAULT 'none',
        verification_record TEXT,
        verification_updated_at DATETIME,
        push_sent_at DATETIME,
        push_channel TEXT,
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
    `ALTER TABLE signals ADD COLUMN verification_status TEXT DEFAULT 'pending'`,
    `ALTER TABLE signals ADD COLUMN verification_score INTEGER DEFAULT 0`,
    `ALTER TABLE signals ADD COLUMN verification_reason TEXT`,
    `ALTER TABLE signals ADD COLUMN verification_flags TEXT DEFAULT '[]'`,
    `ALTER TABLE signals ADD COLUMN verification_source TEXT DEFAULT 'none'`,
    `ALTER TABLE signals ADD COLUMN verification_record TEXT`,
    `ALTER TABLE signals ADD COLUMN verification_updated_at DATETIME`,
    `ALTER TABLE signals ADD COLUMN push_sent_at DATETIME`,
    `ALTER TABLE signals ADD COLUMN push_channel TEXT`,
    `ALTER TABLE whale_events ADD COLUMN trade_id TEXT`,
    `ALTER TABLE tracked_markets ADD COLUMN gamma_id TEXT`,
    `ALTER TABLE tracked_markets ADD COLUMN event_slug TEXT`,

    // Tweet account enrichment
    `ALTER TABLE tweet_accounts ADD COLUMN discovery_source TEXT DEFAULT 'seed'`,
    `ALTER TABLE tweet_accounts ADD COLUMN causality_score REAL DEFAULT 0.35`,
    `ALTER TABLE tweet_accounts ADD COLUMN causal_tags TEXT DEFAULT '[]'`,
    `ALTER TABLE tweet_accounts ADD COLUMN causal_thesis TEXT`,
    `ALTER TABLE tweet_accounts ADD COLUMN discovery_depth INTEGER DEFAULT 0`,
    `ALTER TABLE tweet_accounts ADD COLUMN collect_enabled BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE tweet_accounts ADD COLUMN last_collected_at DATETIME`,
    `ALTER TABLE tweet_accounts ADD COLUMN feed_url TEXT`,
    `ALTER TABLE daily_backtest_runs ADD COLUMN candidate_mode TEXT DEFAULT 'push_only'`,
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists.
    }
  }

  // Cap historical signals at 92 (retroactive one-time correction)
  try {
    db.exec(`UPDATE signals SET confidence = 92 WHERE confidence > 92`);
  } catch {
    // signals table/column may not exist in very old schemas
  }

  try {
    db.exec(`
      UPDATE daily_backtest_runs
      SET candidate_mode = 'push_only'
      WHERE candidate_mode IS NULL OR TRIM(candidate_mode) = ''
    `);
  } catch {
    // table may not exist on very old schema revisions
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

      CREATE TABLE IF NOT EXISTS signal_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL UNIQUE,
        evaluated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        market TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        asset_name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        entry_time DATETIME NOT NULL,
        entry_price REAL NOT NULL,
        move_10m_pct REAL,
        move_30m_pct REAL,
        move_60m_pct REAL,
        favorable_peak_60m_pct REAL,
        adverse_peak_60m_pct REAL,
        direction_correct_30m BOOLEAN,
        direction_correct_60m BOOLEAN,
        confidence_at_signal INTEGER,
        verification_score INTEGER,
        source TEXT DEFAULT 'signal_timestamp',
        FOREIGN KEY (signal_id) REFERENCES signals(id)
      );

      CREATE TABLE IF NOT EXISTS daily_backtest_runs (
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
        ai_notes TEXT,
        UNIQUE(date, market)
      );

      CREATE TABLE IF NOT EXISTS asset_performance (
        asset_id TEXT PRIMARY KEY,
        asset_name TEXT NOT NULL,
        market TEXT NOT NULL,
        samples INTEGER DEFAULT 0,
        hit_rate_30m REAL DEFAULT 0,
        hit_rate_60m REAL DEFAULT 0,
        avg_move_60m REAL DEFAULT 0,
        avg_favorable_60m REAL DEFAULT 0,
        avg_adverse_60m REAL DEFAULT 0,
        reliability_score REAL DEFAULT 0.5,
        suggested_confidence_adjustment INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS asset_push_performance (
        asset_id TEXT PRIMARY KEY,
        asset_name TEXT NOT NULL,
        market TEXT NOT NULL,
        samples INTEGER DEFAULT 0,
        hit_rate_30m REAL DEFAULT 0,
        hit_rate_60m REAL DEFAULT 0,
        avg_move_30m REAL DEFAULT 0,
        avg_move_60m REAL DEFAULT 0,
        reliability_score REAL DEFAULT 0.5,
        gate TEXT DEFAULT 'watch',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS push_policy_config (
        market TEXT PRIMARY KEY CHECK(market IN ('swedish', 'us')),
        min_confidence INTEGER DEFAULT 65,
        min_delta_pct REAL DEFAULT 15,
        min_evidence_score INTEGER DEFAULT 3,
        optimization_score REAL DEFAULT 0,
        sample_count INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS volatility_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        vix REAL,
        regime TEXT CHECK(regime IN ('low', 'normal', 'high', 'extreme')),
        sp500_1h_vol REAL,
        nasdaq_1h_vol REAL
      );

      CREATE TABLE IF NOT EXISTS futures_confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        futures_symbol TEXT NOT NULL,
        futures_return_5m REAL,
        signal_direction TEXT,
        confirmed INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS macro_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_name TEXT NOT NULL,
        event_time DATETIME,
        impact TEXT,
        affected_assets TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS feature_snapshots_1s (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        symbol TEXT NOT NULL,
        asset_id TEXT,
        top_imbalance REAL,
        multi_level_imbalance REAL,
        ofi_proxy REAL,
        micro_price REAL,
        mid_price REAL,
        micro_divergence REAL,
        normalized_micro_divergence REAL,
        spread_bps REAL,
        depth_10bps REAL,
        depth_25bps REAL,
        depth_drop_rate REAL,
        liquidity_cliff BOOLEAN DEFAULT FALSE,
        trade_intensity REAL,
        signed_trade_imbalance REAL,
        short_volatility_pct REAL,
        liquidation_burst_intensity REAL,
        liquidation_direction TEXT,
        liquidation_clustering REAL,
        second_venue_return_5s REAL,
        second_venue_gap_bps REAL
      );

      CREATE TABLE IF NOT EXISTS feature_snapshots_1m (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        symbol TEXT NOT NULL,
        asset_id TEXT,
        top_imbalance_avg REAL,
        multi_level_imbalance_avg REAL,
        ofi_avg REAL,
        micro_divergence_avg REAL,
        spread_bps_avg REAL,
        depth_10bps_avg REAL,
        trade_intensity_avg REAL,
        signed_trade_imbalance_avg REAL,
        short_volatility_pct_avg REAL,
        top_imbalance_persistence_bull REAL,
        top_imbalance_persistence_bear REAL,
        micro_divergence_persistence_bull REAL,
        micro_divergence_persistence_bear REAL,
        imbalance_zscore REAL,
        ofi_zscore REAL,
        regime_label TEXT
      );

      CREATE TABLE IF NOT EXISTS liquidity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        symbol TEXT NOT NULL,
        asset_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT
      );

      CREATE TABLE IF NOT EXISTS liquidation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        symbol TEXT NOT NULL,
        asset_id TEXT,
        side TEXT,
        price REAL,
        quantity REAL
      );

      CREATE TABLE IF NOT EXISTS leader_lag_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        symbol TEXT NOT NULL,
        asset_id TEXT,
        primary_return_5s REAL,
        second_venue_return_5s REAL,
        gap_bps REAL
      );

      CREATE TABLE IF NOT EXISTS fusion_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        signal_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        p_hat REAL NOT NULL,
        expectancy_hat_pct REAL NOT NULL,
        hard_pass BOOLEAN NOT NULL,
        soft_score REAL NOT NULL,
        reasons_json TEXT,
        suppress_reasons_json TEXT,
        feature_flags_used_json TEXT,
        decision TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suppressed_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        signal_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        p_hat REAL,
        expectancy_hat_pct REAL,
        suppress_reasons_json TEXT,
        reasons_json TEXT,
        feature_flags_used_json TEXT
      );

      CREATE TABLE IF NOT EXISTS streaming_health (
        component TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        details TEXT,
        last_message_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS fusion_weight_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        weights_json TEXT NOT NULL,
        metrics_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT FALSE
      );

      CREATE INDEX IF NOT EXISTS idx_feature_snapshots_1s_symbol_time
      ON feature_snapshots_1s(symbol, timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_feature_snapshots_1m_symbol_time
      ON feature_snapshots_1m(symbol, timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_fusion_decisions_signal_time
      ON fusion_decisions(signal_id, timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_suppressed_decisions_time
      ON suppressed_decisions(timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_signal_outcomes_market_time
      ON signal_outcomes(market, evaluated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_signal_outcomes_asset
      ON signal_outcomes(asset_id, evaluated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_push_perf_gate
      ON asset_push_performance(gate, reliability_score DESC, samples DESC);

      INSERT OR IGNORE INTO push_policy_config (market, min_confidence, min_delta_pct, min_evidence_score)
      VALUES
        ('swedish', 65, 15, 3),
        ('us', 65, 15, 3);
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
      event_slug TEXT,
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
      ai_analysis TEXT,
      verification_status TEXT DEFAULT 'pending' CHECK(verification_status IN ('pending', 'approved', 'rejected', 'needs_review')),
      verification_score INTEGER DEFAULT 0,
      verification_reason TEXT,
      verification_flags TEXT DEFAULT '[]',
      verification_source TEXT DEFAULT 'none',
      verification_record TEXT,
      verification_updated_at DATETIME,
      push_sent_at DATETIME,
      push_channel TEXT,
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

    CREATE TABLE IF NOT EXISTS signal_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL UNIQUE,
      evaluated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      market TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      asset_name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      entry_time DATETIME NOT NULL,
      entry_price REAL NOT NULL,
      move_10m_pct REAL,
      move_30m_pct REAL,
      move_60m_pct REAL,
      favorable_peak_60m_pct REAL,
      adverse_peak_60m_pct REAL,
      direction_correct_30m BOOLEAN,
      direction_correct_60m BOOLEAN,
      confidence_at_signal INTEGER,
      verification_score INTEGER,
      source TEXT DEFAULT 'signal_timestamp',
      FOREIGN KEY (signal_id) REFERENCES signals(id)
    );

    CREATE TABLE IF NOT EXISTS daily_backtest_runs (
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
      ai_notes TEXT,
      UNIQUE(date, market)
    );

    CREATE TABLE IF NOT EXISTS asset_performance (
      asset_id TEXT PRIMARY KEY,
      asset_name TEXT NOT NULL,
      market TEXT NOT NULL,
      samples INTEGER DEFAULT 0,
      hit_rate_30m REAL DEFAULT 0,
      hit_rate_60m REAL DEFAULT 0,
      avg_move_60m REAL DEFAULT 0,
      avg_favorable_60m REAL DEFAULT 0,
      avg_adverse_60m REAL DEFAULT 0,
      reliability_score REAL DEFAULT 0.5,
      suggested_confidence_adjustment INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS asset_push_performance (
      asset_id TEXT PRIMARY KEY,
      asset_name TEXT NOT NULL,
      market TEXT NOT NULL,
      samples INTEGER DEFAULT 0,
      hit_rate_30m REAL DEFAULT 0,
      hit_rate_60m REAL DEFAULT 0,
      avg_move_30m REAL DEFAULT 0,
      avg_move_60m REAL DEFAULT 0,
      reliability_score REAL DEFAULT 0.5,
      gate TEXT DEFAULT 'watch',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS push_policy_config (
      market TEXT PRIMARY KEY CHECK(market IN ('swedish', 'us')),
      min_confidence INTEGER DEFAULT 65,
      min_delta_pct REAL DEFAULT 15,
      min_evidence_score INTEGER DEFAULT 3,
      optimization_score REAL DEFAULT 0,
      sample_count INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS volatility_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      vix REAL,
      regime TEXT CHECK(regime IN ('low', 'normal', 'high', 'extreme')),
      sp500_1h_vol REAL,
      nasdaq_1h_vol REAL
    );

    CREATE TABLE IF NOT EXISTS futures_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      futures_symbol TEXT NOT NULL,
      futures_return_5m REAL,
      signal_direction TEXT,
      confirmed INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS macro_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_name TEXT NOT NULL,
      event_time DATETIME,
      impact TEXT,
      affected_assets TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS feature_snapshots_1s (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      symbol TEXT NOT NULL,
      asset_id TEXT,
      top_imbalance REAL,
      multi_level_imbalance REAL,
      ofi_proxy REAL,
      micro_price REAL,
      mid_price REAL,
      micro_divergence REAL,
      normalized_micro_divergence REAL,
      spread_bps REAL,
      depth_10bps REAL,
      depth_25bps REAL,
      depth_drop_rate REAL,
      liquidity_cliff BOOLEAN DEFAULT FALSE,
      trade_intensity REAL,
      signed_trade_imbalance REAL,
      short_volatility_pct REAL,
      liquidation_burst_intensity REAL,
      liquidation_direction TEXT,
      liquidation_clustering REAL,
      second_venue_return_5s REAL,
      second_venue_gap_bps REAL
    );

    CREATE TABLE IF NOT EXISTS feature_snapshots_1m (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      symbol TEXT NOT NULL,
      asset_id TEXT,
      top_imbalance_avg REAL,
      multi_level_imbalance_avg REAL,
      ofi_avg REAL,
      micro_divergence_avg REAL,
      spread_bps_avg REAL,
      depth_10bps_avg REAL,
      trade_intensity_avg REAL,
      signed_trade_imbalance_avg REAL,
      short_volatility_pct_avg REAL,
      top_imbalance_persistence_bull REAL,
      top_imbalance_persistence_bear REAL,
      micro_divergence_persistence_bull REAL,
      micro_divergence_persistence_bear REAL,
      imbalance_zscore REAL,
      ofi_zscore REAL,
      regime_label TEXT
    );

    CREATE TABLE IF NOT EXISTS liquidity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      symbol TEXT NOT NULL,
      asset_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT
    );

    CREATE TABLE IF NOT EXISTS liquidation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      symbol TEXT NOT NULL,
      asset_id TEXT,
      side TEXT,
      price REAL,
      quantity REAL
    );

    CREATE TABLE IF NOT EXISTS leader_lag_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      symbol TEXT NOT NULL,
      asset_id TEXT,
      primary_return_5s REAL,
      second_venue_return_5s REAL,
      gap_bps REAL
    );

    CREATE TABLE IF NOT EXISTS fusion_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      signal_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      p_hat REAL NOT NULL,
      expectancy_hat_pct REAL NOT NULL,
      hard_pass BOOLEAN NOT NULL,
      soft_score REAL NOT NULL,
      reasons_json TEXT,
      suppress_reasons_json TEXT,
      feature_flags_used_json TEXT,
      decision TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppressed_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      signal_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      p_hat REAL,
      expectancy_hat_pct REAL,
      suppress_reasons_json TEXT,
      reasons_json TEXT,
      feature_flags_used_json TEXT
    );

    CREATE TABLE IF NOT EXISTS streaming_health (
      component TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      details TEXT,
      last_message_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fusion_weight_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      weights_json TEXT NOT NULL,
      metrics_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_feature_snapshots_1s_symbol_time
    ON feature_snapshots_1s(symbol, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_feature_snapshots_1m_symbol_time
    ON feature_snapshots_1m(symbol, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_fusion_decisions_signal_time
    ON fusion_decisions(signal_id, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_suppressed_decisions_time
    ON suppressed_decisions(timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_signal_outcomes_market_time
    ON signal_outcomes(market, evaluated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_signal_outcomes_asset
    ON signal_outcomes(asset_id, evaluated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_push_perf_gate
    ON asset_push_performance(gate, reliability_score DESC, samples DESC);

    INSERT OR IGNORE INTO push_policy_config (market, min_confidence, min_delta_pct, min_evidence_score)
    VALUES
      ('swedish', 65, 15, 3),
      ('us', 65, 15, 3);
  `);

  console.log('Database initialized successfully at:', DB_PATH);
}

export function getDatabase(): Database.Database {
  return new Database(DB_PATH);
}
