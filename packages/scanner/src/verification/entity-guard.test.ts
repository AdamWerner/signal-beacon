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

  it('rejects sportsbook license enforcement for Evolution Gaming', () => {
    const result = guard.evaluate(buildContext({
      marketTitle: 'Will Ohio Revoke Any OSB License Over Event-Contract Activity by March 31?',
      marketDescription: 'This market resolves based on an online sports betting provider licensed in Ohio.',
      matchedAssetId: 'gaming-evolution',
      matchedAssetName: 'Evolution Gaming',
      ontologyKeywords: []
    }));

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('Evolution Gaming');
    expect(result.flags).toContain('sportsbook_operator_regulation');
  });

  it('downgrades negated macro questions for manual review', () => {
    const result = guard.evaluate(buildContext({
      marketTitle: 'Will the Fed not cut rates in June?',
      marketCategory: 'macro',
      matchedAssetId: 'sp500',
      matchedAssetName: 'S&P 500',
      ontologyKeywords: ['fed']
    }));

    expect(result.status).toBe('needs_review');
    expect(result.flags).toContain('negated_market_language');
  });

  it('rejects keyword-only matches with weak market context', () => {
    const result = guard.evaluate(buildContext({
      marketTitle: 'Will Spotify Wrapped break records this year?',
      marketCategory: 'entertainment',
      matchedAssetId: 'tech-spotify',
      matchedAssetName: 'Spotify Technology',
      ontologyKeywords: ['spotify']
    }));

    expect(result.status).toBe('rejected');
    expect(result.flags).toContain('keyword_only_match');
  });

  // --- Negation fix tests ---

  it('approves crude oil market despite resolution boilerplate with NOT in description', () => {
    // "does not settle above" in description should NOT trigger negation flag —
    // the check is title-only and stripResolutionClauses removes resolution rules.
    const result = guard.evaluate(buildContext({
      marketTitle: 'Will crude oil settle above $80 by April 30?',
      marketDescription: 'Resolves NO if the market does not settle above $80 by April 30.',
      matchedAssetId: 'oil-equinor',
      matchedAssetName: 'Equinor',
      ontologyKeywords: ['oil', 'crude']
    }));

    expect(result.flags).not.toContain('negated_market_language');
    expect(result.status).toBe('approved');
  });

  it('flags "Will the Fed NOT cut rates in April?" as needs_review with negation flag', () => {
    const result = guard.evaluate(buildContext({
      marketTitle: 'Will the Fed NOT cut rates in April?',
      matchedAssetId: 'sp500',
      matchedAssetName: 'S&P 500',
      ontologyKeywords: ['fed', 'rate cut']
    }));

    expect(result.flags).toContain('negated_market_language');
    expect(result.status).toBe('needs_review');
  });

  it('does NOT flag "Is blockchain regulation coming?" — blockchain contains block but is a standalone word', () => {
    // "blockchain" must NOT match the \bblock\b word-boundary regex.
    const result = guard.evaluate(buildContext({
      marketTitle: 'Is blockchain regulation coming?',
      matchedAssetId: 'crypto-bitcoin',
      matchedAssetName: 'Bitcoin',
      ontologyKeywords: ['blockchain', 'regulation']
    }));

    expect(result.flags).not.toContain('negated_market_language');
  });

  it('flags "Russia stopped gas exports" as needs_review with negation flag when ontology matches', () => {
    const result = guard.evaluate(buildContext({
      marketTitle: 'Russia stopped gas exports to Europe',
      matchedAssetId: 'energy-equinor',
      matchedAssetName: 'Equinor',
      ontologyKeywords: ['equinor', 'gas']
    }));

    expect(result.flags).toContain('negated_market_language');
    expect(result.status).toBe('needs_review');
  });
});
