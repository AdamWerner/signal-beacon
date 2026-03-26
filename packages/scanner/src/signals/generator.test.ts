import { describe, expect, it } from 'vitest';
import { SignalGenerator } from './generator.js';

function createGenerator(): SignalGenerator {
  return new SignalGenerator(
    {
      determineTradingDirection: () => 'bull',
      getSuggestedInstruments: () => [],
      getMappingForAsset: () => null
    } as any,
    {} as any,
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
