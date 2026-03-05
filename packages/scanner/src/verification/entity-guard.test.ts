import { describe, expect, it } from 'vitest';
import { EntityRelevanceGuard } from './entity-guard.js';
import { VerificationContext } from './types.js';

function buildContext(overrides: Partial<VerificationContext>): VerificationContext {
  return {
    marketTitle: 'Will event happen?',
    marketDescription: null,
    marketCategory: 'politics',
    matchedAssetId: 'ev-tesla',
    matchedAssetName: 'Tesla',
    polarity: 'direct',
    suggestedAction: 'Consider BULL position',
    oddsBefore: 0.3,
    oddsNow: 0.42,
    deltaPct: 40,
    timeframeMinutes: 60,
    whaleDetected: false,
    whaleAmountUsd: null,
    ontologyKeywords: [],
    reinforcingSignals: [],
    conflictingSignals: [],
    ...overrides
  };
}

describe('EntityRelevanceGuard', () => {
  const guard = new EntityRelevanceGuard(0.55, 'block');

  it('rejects unknown person legal event mapped to Tesla', () => {
    const result = guard.evaluate(buildContext({
      marketTitle: 'Will John Doe be arrested before July?',
      marketDescription: 'Criminal indictment speculation',
      matchedAssetId: 'ev-tesla',
      matchedAssetName: 'Tesla',
      ontologyKeywords: []
    }));

    expect(result.status).toBe('rejected');
    expect(result.flags.some(flag => flag.includes('unknown'))).toBe(true);
  });

  it('approves known person linked to Tesla', () => {
    const result = guard.evaluate(buildContext({
      marketTitle: 'Will Elon Musk unveil Tesla Robotaxi production plans?',
      matchedAssetId: 'ev-tesla',
      matchedAssetName: 'Tesla',
      ontologyKeywords: ['tesla', 'robotaxi']
    }));

    expect(result.status).toBe('approved');
    expect(result.knownEntityLinked).toBe(true);
  });

  it('approves macro Fed event for SP500 with explicit keywords', () => {
    const result = guard.evaluate(buildContext({
      marketTitle: 'Will Fed cut rates by 25 bps in September?',
      marketCategory: 'macro',
      matchedAssetId: 'sp500',
      matchedAssetName: 'S&P 500',
      ontologyKeywords: ['fed', 'rate cut']
    }));

    expect(result.status).toBe('approved');
    expect(result.allowlistedMarketType).toBe(true);
  });
});
