import { describe, expect, it } from 'vitest';
import { SignalGenerator } from './generator.js';

function createGenerator(): SignalGenerator {
  return new SignalGenerator(
    {
      determineTradingDirection: () => 'bull',
      getSuggestedInstruments: () => [],
      getMappingForAsset: (assetId: string) => ({
        assetId,
        assetName: assetId,
        polarity: 'direct',
        explanation: 'test',
        instruments: { bull: [], bear: [] }
      })
    } as any,
    { insert: () => {} } as any,
    {} as any,
    {
      findFiltered: () => [],
      findRecentByDeduplicationKey: () => null,
      insert: () => {}
    } as any,
    {
      guardOnly: () => ({
        status: 'approved',
        score: 0,
        reason: '',
        flags: [],
        source: 'fallback_guard',
        record: {},
        confidenceAdjustment: 0
      }),
      batchVerifyTopCandidates: async () => new Map()
    } as any,
    {
      getHistory: () => []
    } as any
  );
}

describe('SignalGenerator context-dependent direction', () => {
  it('treats rising odds on Fed cuts as bullish for SP500', () => {
    const generator = createGenerator() as any;
    const direction = generator.resolveContextDependentDirection(
      { delta_pct: 22 },
      { title: 'Will the Fed cut rates by July?', description: null },
      { assetId: 'sp500' }
    );

    expect(direction).toBe('bull');
  });

  it('treats rising odds on Fed hikes as bearish for SP500', () => {
    const generator = createGenerator() as any;
    const direction = generator.resolveContextDependentDirection(
      { delta_pct: 22 },
      { title: 'Will the Fed hike rates again this year?', description: null },
      { assetId: 'sp500' }
    );

    expect(direction).toBe('bear');
  });

  it('treats rising odds on no Fed cuts as bearish for SP500', () => {
    const generator = createGenerator() as any;
    const direction = generator.resolveContextDependentDirection(
      { delta_pct: 22 },
      { title: 'Will no Fed rate cuts happen in 2026?', description: null },
      { assetId: 'sp500' }
    );

    expect(direction).toBe('bear');
  });

  it('blocks ambiguous context-dependent markets instead of defaulting to bull', () => {
    const generator = createGenerator() as any;
    const direction = generator.resolveContextDependentDirection(
      { delta_pct: 22 },
      { title: 'Will Spotify be mentioned in a market this week?', description: null },
      { assetId: 'tech-spotify' }
    );

    expect(direction).toBeNull();
  });
});

describe('SignalGenerator catalyst convergence', () => {
  it('blocks price-action-only convergence from volume plus technical', async () => {
    const generator = createGenerator();
    const now = new Date().toISOString();

    const signals = await generator.generateCatalystSignals([
      {
        sourceType: 'finviz_volume',
        sourceKey: 'vol',
        ticker: 'XOM',
        assetId: 'oil-exxon',
        assetName: 'Exxon Mobil',
        title: 'XOM up 4.6% intraday',
        body: '',
        directionHint: 'bull',
        urgency: 'high',
        timestamp: now
      },
      {
        sourceType: 'technical_breakout',
        sourceKey: 'tech',
        ticker: 'XOM',
        assetId: 'oil-exxon',
        assetName: 'Exxon Mobil',
        title: 'Exxon Mobil technical breakout',
        body: '',
        directionHint: 'bull',
        urgency: 'high',
        timestamp: now
      }
    ]);

    expect(signals).toHaveLength(0);
  });
});
