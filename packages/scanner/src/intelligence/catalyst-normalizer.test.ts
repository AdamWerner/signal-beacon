import { describe, expect, it } from 'vitest';
import { CatalystNormalizer } from './catalyst-normalizer.js';

describe('CatalystNormalizer', () => {
  const normalizer = new CatalystNormalizer();

  it('classifies macro rate catalysts', () => {
    const result = normalizer.normalize({
      sourceType: 'polymarket',
      title: 'Will the Fed cut rates after CPI cools in April?',
      assetId: 'sp500',
      assetName: 'S&P 500',
      hintedDirection: 'bull'
    });

    expect(result.sourceFamily).toBe('macro_rates');
    expect(result.eventType).toBe('rate_policy');
    expect(result.directionHint).toBe('bull');
    expect(result.isNoise).toBe(false);
  });

  it('rejects media/podcast noise as catalysts', () => {
    const result = normalizer.normalize({
      sourceType: 'news',
      title: 'Will creator X appear on a podcast before July?',
      assetId: 'tech-spotify',
      assetName: 'Spotify Technology'
    });

    expect(result.isNoise).toBe(true);
    expect(result.eventType).toBe('noise');
  });

  it('separates circular crypto price ladders from real crypto catalysts', () => {
    const result = normalizer.normalize({
      sourceType: 'polymarket',
      title: 'Will the price of Bitcoin be above $74,000 on March 19?',
      assetId: 'crypto-coinbase',
      assetName: 'Coinbase Global',
      hintedDirection: 'bull',
      recentSimilarCount: 4
    });

    expect(result.sourceFamily).toBe('crypto_proxy_market');
    expect(result.eventType).toBe('proxy_price_ladder');
    expect(result.causalStrength).toBeLessThan(0.3);
    expect(result.isNoise).toBe(false);
  });

  it('does not treat internal reasoning tags as market noise', () => {
    const result = normalizer.normalize({
      sourceType: 'polymarket',
      title: 'Will Tesla (TSLA) close above $380 on March 19?',
      body: 'Polymarket move [score: base:44, verify:+6]',
      assetId: 'ev-tesla',
      assetName: 'Tesla',
      hintedDirection: 'bull'
    });

    expect(result.sourceFamily).toBe('asset_proxy_market');
    expect(result.isNoise).toBe(false);
  });
});
