import { describe, expect, it } from 'vitest';
import { FusionEngine } from './engine.js';
import { FusionInputs } from './types.js';

const baseInputs: FusionInputs = {
  signalId: 'sig_1',
  assetId: 'crypto-coinbase',
  assetName: 'Coinbase',
  symbol: 'BTCUSDT',
  direction: 'bull',
  signalConfidence: 70,
  signalDeltaPct: 25,
  feature1s: {
    timestamp: new Date().toISOString(),
    symbol: 'BTCUSDT',
    topImbalance: 0.3,
    multiLevelImbalance: 0.25,
    ofiProxy: 12,
    microPrice: 101,
    midPrice: 100.5,
    microDivergence: 0.5,
    normalizedMicroDivergence: 0.5,
    spreadBps: 6,
    depth10bps: 120,
    depth25bps: 200,
    depthDropRate: 0.1,
    liquidityCliff: false,
    tradeIntensity: 40,
    signedTradeImbalance: 10,
    shortVolatilityPct: 0.2
  },
  feature1m: {
    timestamp: new Date().toISOString(),
    symbol: 'BTCUSDT',
    topImbalanceAvg: 0.2,
    multiLevelImbalanceAvg: 0.2,
    ofiAvg: 6,
    microDivergenceAvg: 0.2,
    spreadBpsAvg: 7,
    depth10bpsAvg: 110,
    tradeIntensityAvg: 30,
    signedTradeImbalanceAvg: 8,
    shortVolatilityPctAvg: 0.25,
    topImbalancePersistenceBull: 0.65,
    topImbalancePersistenceBear: 0.1,
    microDivergencePersistenceBull: 0.6,
    microDivergencePersistenceBear: 0.2,
    imbalanceZScore: 1.2,
    ofiZScore: 1.4,
    regimeLabel: 'normal'
  },
  secondVenueEnabled: true,
  liquidationEnabled: false,
  stale: false
};

describe('FusionEngine', () => {
  it('allows aligned high-quality setup', () => {
    const engine = new FusionEngine({ pHatMin: 0.55, expectancyMinPct: 0.3 });
    const decision = engine.evaluate(baseInputs);
    expect(decision.decision).toBe('allow');
    expect(decision.pHat).toBeGreaterThan(0.55);
  });

  it('allows realistic BTC depth when the rest of the tape is aligned', () => {
    const engine = new FusionEngine({ pHatMin: 0.53, expectancyMinPct: 0.2 });
    const decision = engine.evaluate({
      ...baseInputs,
      feature1s: {
        ...baseInputs.feature1s!,
        depth10bps: 14,
        normalizedMicroDivergence: 0.08
      },
      feature1m: {
        ...baseInputs.feature1m!,
        topImbalancePersistenceBull: 0.41
      }
    });
    expect(decision.decision).toBe('allow');
  });

  it('suppresses when hard gate fails', () => {
    const engine = new FusionEngine({ pHatMin: 0.55, expectancyMinPct: 0.3 });
    const decision = engine.evaluate({
      ...baseInputs,
      feature1s: {
        ...baseInputs.feature1s!,
        spreadBps: 30,
        depth10bps: 5
      }
    });
    expect(decision.decision).toBe('suppress');
    expect(decision.hardPass).toBe(false);
  });

  it('falls back to phase1 on stale data', () => {
    const engine = new FusionEngine({ pHatMin: 0.55, expectancyMinPct: 0.3 });
    const decision = engine.evaluate({ ...baseInputs, stale: true });
    expect(decision.decision).toBe('fallback_phase1');
  });
});
