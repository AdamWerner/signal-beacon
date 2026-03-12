import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureAggregator } from './features/aggregator.js';
import { FusionEngine } from './fusion/engine.js';
import { OrderBookManager } from './orderbook/orderbook-manager.js';
import { StreamingFeatureService } from './services/streaming-feature-service.js';
import { StreamingHealthService } from './services/streaming-health-service.js';
import { StreamingSymbolMap } from './services/symbol-map.js';
import { StreamingStore } from './storage/streaming-store.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE feature_snapshots_1s (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT, symbol TEXT, asset_id TEXT,
      top_imbalance REAL, multi_level_imbalance REAL, ofi_proxy REAL,
      micro_price REAL, mid_price REAL, micro_divergence REAL, normalized_micro_divergence REAL,
      spread_bps REAL, depth_10bps REAL, depth_25bps REAL, depth_drop_rate REAL, liquidity_cliff INTEGER,
      trade_intensity REAL, signed_trade_imbalance REAL, short_volatility_pct REAL,
      liquidation_burst_intensity REAL, liquidation_direction TEXT, liquidation_clustering REAL,
      second_venue_return_5s REAL, second_venue_gap_bps REAL
    );
    CREATE TABLE feature_snapshots_1m (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT, symbol TEXT, asset_id TEXT,
      top_imbalance_avg REAL, multi_level_imbalance_avg REAL, ofi_avg REAL,
      micro_divergence_avg REAL, spread_bps_avg REAL, depth_10bps_avg REAL, trade_intensity_avg REAL,
      signed_trade_imbalance_avg REAL, short_volatility_pct_avg REAL,
      top_imbalance_persistence_bull REAL, top_imbalance_persistence_bear REAL,
      micro_divergence_persistence_bull REAL, micro_divergence_persistence_bear REAL,
      imbalance_zscore REAL, ofi_zscore REAL, regime_label TEXT
    );
    CREATE TABLE liquidity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, symbol TEXT, asset_id TEXT, event_type TEXT, payload TEXT);
    CREATE TABLE liquidation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, symbol TEXT, asset_id TEXT, side TEXT, price REAL, quantity REAL);
    CREATE TABLE leader_lag_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, symbol TEXT, asset_id TEXT, primary_return_5s REAL, second_venue_return_5s REAL, gap_bps REAL);
    CREATE TABLE fusion_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, signal_id TEXT, asset_id TEXT, symbol TEXT, direction TEXT, p_hat REAL, expectancy_hat_pct REAL, hard_pass INTEGER, soft_score REAL, reasons_json TEXT, suppress_reasons_json TEXT, feature_flags_used_json TEXT, decision TEXT);
    CREATE TABLE suppressed_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, signal_id TEXT, asset_id TEXT, symbol TEXT, direction TEXT, p_hat REAL, expectancy_hat_pct REAL, suppress_reasons_json TEXT, reasons_json TEXT, feature_flags_used_json TEXT);
    CREATE TABLE streaming_health (component TEXT PRIMARY KEY, status TEXT, details TEXT, last_message_at TEXT, updated_at TEXT);
  `);
  return db;
}

describe('streaming integration', () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('aggregates simulated book + trades into snapshot', () => {
    db = createDb();
    const store = new StreamingStore(db);
    const symbolMap = new StreamingSymbolMap();
    const books = new OrderBookManager(20);
    const aggregator = new FeatureAggregator(books, store, symbolMap);

    books.applySnapshot('BTCUSDT', {
      lastUpdateId: 10,
      bids: [{ price: 100, size: 6 }],
      asks: [{ price: 101, size: 4 }]
    });
    aggregator.onTrade({
      symbol: 'BTCUSDT',
      price: 100.8,
      quantity: 2,
      timestamp: Date.now(),
      isBuyerMaker: false
    });

    (aggregator as any).captureTick();
    const snapshot = store.getLatestSnapshot('BTCUSDT');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.spreadBps).toBeGreaterThan(0);
  });

  it('stores allow and suppress fusion decisions from evaluated candidates', () => {
    db = createDb();
    const store = new StreamingStore(db);
    const engine = new FusionEngine({ pHatMin: 0.55, expectancyMinPct: 0.3 });

    const allowInputs = {
      signalId: 'sig_allow',
      assetId: 'crypto-coinbase',
      assetName: 'Coinbase',
      symbol: 'BTCUSDT',
      direction: 'bull',
      signalConfidence: 72,
      signalDeltaPct: 20,
      feature1s: {
        timestamp: new Date().toISOString(),
        symbol: 'BTCUSDT',
        topImbalance: 0.2,
        multiLevelImbalance: 0.2,
        ofiProxy: 10,
        microPrice: 101,
        midPrice: 100.5,
        microDivergence: 0.5,
        normalizedMicroDivergence: 0.4,
        spreadBps: 6,
        depth10bps: 120,
        depth25bps: 220,
        depthDropRate: 0.1,
        liquidityCliff: false,
        tradeIntensity: 30,
        signedTradeImbalance: 5,
        shortVolatilityPct: 0.2
      },
      feature1m: {
        timestamp: new Date().toISOString(),
        symbol: 'BTCUSDT',
        topImbalanceAvg: 0.15,
        multiLevelImbalanceAvg: 0.18,
        ofiAvg: 6,
        microDivergenceAvg: 0.2,
        spreadBpsAvg: 7,
        depth10bpsAvg: 130,
        tradeIntensityAvg: 20,
        signedTradeImbalanceAvg: 4,
        shortVolatilityPctAvg: 0.2,
        topImbalancePersistenceBull: 0.6,
        topImbalancePersistenceBear: 0.1,
        microDivergencePersistenceBull: 0.65,
        microDivergencePersistenceBear: 0.1,
        imbalanceZScore: 1,
        ofiZScore: 1,
        regimeLabel: 'normal'
      },
      secondVenueEnabled: false,
      liquidationEnabled: false,
      stale: false
    } as any;
    const allow = engine.evaluate(allowInputs);

    const suppress = engine.evaluate({
      ...allowInputs,
      signalId: 'sig_suppress',
      feature1s: { ...allowInputs.feature1s, spreadBps: 30, depth10bps: 20 }
    });

    store.insertFusionDecision(allow);
    store.insertFusionDecision(suppress);
    if (suppress.decision === 'suppress') {
      store.insertSuppressedDecision(suppress);
    }

    expect(store.getFusionDecisions(10).length).toBe(2);
    expect(store.getSuppressedDecisions(10).length).toBe(1);
  });

  it('marks fusion inputs stale when streaming health is stale', () => {
    db = createDb();
    const store = new StreamingStore(db);
    const symbolMap = new StreamingSymbolMap();
    const books = new OrderBookManager(20);
    const aggregator = new FeatureAggregator(books, store, symbolMap);
    const health = new StreamingHealthService(10);
    const service = new StreamingFeatureService(aggregator, store, symbolMap, health, 10);

    store.insertFeatureSnapshot1s({
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      symbol: 'BTCUSDT',
      topImbalance: 0.1,
      multiLevelImbalance: 0.1,
      ofiProxy: 1,
      microPrice: 101,
      midPrice: 100.5,
      microDivergence: 0.5,
      normalizedMicroDivergence: 0.5,
      spreadBps: 10,
      depth10bps: 100,
      depth25bps: 200,
      depthDropRate: 0,
      liquidityCliff: false,
      tradeIntensity: 1,
      signedTradeImbalance: 1,
      shortVolatilityPct: 0.1
    }, 'crypto-coinbase');

    const inputs = service.getFusionInputsForAsset({
      signalId: 'sig_x',
      assetId: 'crypto-coinbase',
      assetName: 'Coinbase',
      directionHint: 'bull',
      signalConfidence: 60,
      signalDeltaPct: 10,
      secondVenueEnabled: false,
      liquidationEnabled: false
    });

    expect(inputs).not.toBeNull();
    expect(inputs!.stale).toBe(true);
  });
});
