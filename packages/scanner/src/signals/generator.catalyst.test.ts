/**
 * Tests for the RSS-burst carve-out in generateCatalystSignals.
 * These verify that a strong unanimous burst of rss_news catalysts can
 * originate a signal without 2-family convergence, and that the guard
 * conditions (handles, unanimity, urgency) are enforced.
 */
import { describe, expect, it } from 'vitest';
import { SignalGenerator } from './generator.js';
import type { SourceCatalyst } from '../sources/types.js';

// Minimal generator with permissive mocks
function createGenerator(insertedSignals: any[] = []): SignalGenerator {
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
    { insert: (m: any) => {} } as any,
    {} as any,
    {
      findFiltered: () => [],
      findRecentByDeduplicationKey: () => null,
      insert: (s: any) => { insertedSignals.push(s); },
      recordCatalystRejection: () => {}
    } as any,
    {
      guardOnly: () => ({
        status: 'approved',
        score: 80,
        reason: 'test-approved',
        flags: [],
        source: 'guard' as const,
        record: {},
        confidenceAdjustment: 0
      }),
      batchVerifyTopCandidates: async () => new Map()
    } as any,
    { getHistory: () => [] } as any
  );
}

function makeRssCatalyst(
  overrides: Partial<SourceCatalyst> & { sourceCount?: number; isBreaking?: boolean } = {}
): SourceCatalyst {
  const { sourceCount = 1, isBreaking = false, ...rest } = overrides;
  return {
    sourceType: 'rss_news',
    sourceKey: `rss_news:oil-equinor:bear:2026-04-08T12`,
    ticker: '',
    assetId: 'oil-equinor',
    assetName: 'Equinor',
    title: 'Oil crisis news',
    body: 'Hormuz at risk',
    directionHint: 'bear',
    urgency: isBreaking ? 'high' : 'medium',
    timestamp: new Date().toISOString(),
    metadata: { sourceCount, isBreaking, sources: [], totalBoost: 5 },
    ...rest
  };
}

describe('RSS-burst carve-out in generateCatalystSignals', () => {
  it('3 RSS handles unanimous breaking → NO signal (below 4-handle threshold)', async () => {
    const inserted: any[] = [];
    const gen = createGenerator(inserted);
    const catalysts: SourceCatalyst[] = [
      makeRssCatalyst({ sourceKey: 'k1', sourceCount: 3, isBreaking: true })
    ];
    await gen.generateCatalystSignals(catalysts);
    expect(inserted).toHaveLength(0);
  });

  it('4 RSS handles unanimous breaking → signal at confidence 62', async () => {
    const inserted: any[] = [];
    const gen = createGenerator(inserted);
    const catalysts: SourceCatalyst[] = [
      makeRssCatalyst({ sourceKey: 'k1', sourceCount: 4, isBreaking: true })
    ];
    const signals = await gen.generateCatalystSignals(catalysts);
    expect(signals.length).toBeGreaterThan(0);
    // confidence = min(62 + min(4-4, 6)*2, 74) = 62; after verify adjustment = 62+0 = 62
    expect(signals[0].confidence).toBe(62);
    expect(signals[0].reasoning).toContain('[rss-origin:');
    expect(signals[0].reasoning).toContain('4 handles');
  });

  it('8 RSS handles unanimous breaking → signal at confidence 70', async () => {
    const inserted: any[] = [];
    const gen = createGenerator(inserted);
    const catalysts: SourceCatalyst[] = [
      makeRssCatalyst({ sourceKey: 'k1', sourceCount: 8, isBreaking: true })
    ];
    const signals = await gen.generateCatalystSignals(catalysts);
    expect(signals.length).toBeGreaterThan(0);
    // confidence = min(62 + min(8-4, 6)*2, 74) = min(62+8, 74) = 70
    expect(signals[0].confidence).toBe(70);
  });

  it('4 RSS handles mixed directions → NO signal', async () => {
    const inserted: any[] = [];
    const gen = createGenerator(inserted);
    // Two catalysts in same bucket: one bear, one bull — not unanimous
    const catalysts: SourceCatalyst[] = [
      makeRssCatalyst({ sourceKey: 'k1', assetId: 'oil-equinor', directionHint: 'bear', sourceCount: 2, isBreaking: true }),
      makeRssCatalyst({ sourceKey: 'k2', assetId: 'oil-equinor', directionHint: 'bull', sourceCount: 2, isBreaking: true })
    ];
    await gen.generateCatalystSignals(catalysts);
    expect(inserted).toHaveLength(0);
  });

  it('4 RSS handles unanimous but NOT breaking and urgency=medium → NO signal', async () => {
    const inserted: any[] = [];
    const gen = createGenerator(inserted);
    const catalysts: SourceCatalyst[] = [
      makeRssCatalyst({ sourceKey: 'k1', sourceCount: 4, isBreaking: false, urgency: 'medium' })
    ];
    await gen.generateCatalystSignals(catalysts);
    expect(inserted).toHaveLength(0);
  });

  it('2 RSS + 1 technical + 1 econ → goes through regular convergence path, NOT the RSS carve-out', async () => {
    const inserted: any[] = [];
    const gen = createGenerator(inserted);
    // Mix of source types — should use regular 2-family path
    const catalysts: SourceCatalyst[] = [
      makeRssCatalyst({ sourceKey: 'k1', sourceCount: 2, isBreaking: false }),
      {
        sourceType: 'technical_breakout',
        sourceKey: 'tech:oil-equinor:bear',
        ticker: 'EQNR',
        assetId: 'oil-equinor',
        assetName: 'Equinor',
        title: 'Technical breakdown',
        body: 'EQNR broke support',
        directionHint: 'bear',
        urgency: 'medium',
        timestamp: new Date().toISOString()
      },
      {
        sourceType: 'econ_surprise',
        sourceKey: 'econ:oil-equinor:bear',
        ticker: '',
        assetId: 'oil-equinor',
        assetName: 'Equinor',
        title: 'EIA inventory surprise',
        body: 'Oil inventories above expectations',
        directionHint: 'bear',
        urgency: 'high',
        timestamp: new Date().toISOString()
      }
    ];
    const signals = await gen.generateCatalystSignals(catalysts);
    expect(signals.length).toBeGreaterThan(0);
    // Regular path: families are 'news' + 'technical' + 'macro', aligned = 3
    // Confidence: sourceCount=3 → 65 + hasTechnical+hasNewsLike +10 + macro +8 = ≥65
    expect(signals[0].confidence).toBeGreaterThan(62); // higher than RSS-only floor
    // Reasoning should NOT contain rss-origin tag since not RSS-only carve-out
    expect(signals[0].reasoning).not.toContain('[rss-origin:');
  });
});
