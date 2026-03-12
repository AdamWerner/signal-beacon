import { describe, expect, it } from 'vitest';
import { computeMicroPrice, computeNormalizedMicroDivergence } from './microprice.js';
import { computeOfiProxy } from './ofi.js';
import { detectLiquidityCliff } from './liquidity.js';

describe('micro-price', () => {
  it('computes micro price and normalized divergence', () => {
    const micro = computeMicroPrice(
      { price: 100, size: 8 },
      { price: 101, size: 2 }
    );
    expect(micro).toBeCloseTo(100.8, 4);

    const normalized = computeNormalizedMicroDivergence(micro, 100.5, 1);
    expect(normalized).toBeCloseTo(0.3, 4);
  });
});

describe('OFI proxy', () => {
  it('returns positive value when bid strengthens', () => {
    const ofi = computeOfiProxy({
      prevBidPrice: 100,
      prevBidSize: 5,
      prevAskPrice: 101,
      prevAskSize: 5,
      bidPrice: 100.1,
      bidSize: 7,
      askPrice: 101,
      askSize: 4,
      signedTradeImbalance: 1
    });
    expect(ofi).toBeGreaterThan(0);
  });
});

describe('liquidity cliff detector', () => {
  it('flags cliff on large depth drop', () => {
    expect(detectLiquidityCliff(0.45, 8)).toBe(true);
  });

  it('flags cliff on extreme spread', () => {
    expect(detectLiquidityCliff(0.1, 22)).toBe(true);
  });
});
