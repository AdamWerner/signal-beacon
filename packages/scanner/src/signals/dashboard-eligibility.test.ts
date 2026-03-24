import { describe, expect, it } from 'vitest';
import {
  getSignalTradeType,
  hasExternalProxyCorroboration,
  isDashboardEligibleSignal
} from './dashboard-eligibility.js';

describe('dashboard proxy eligibility', () => {
  it('allows direct signals through', () => {
    expect(isDashboardEligibleSignal({ primary_source_family: 'macro_rates' })).toBe(true);
    expect(getSignalTradeType({ primary_source_family: 'macro_rates' })).toBe('direct');
  });

  it('blocks uncorroborated crypto proxy signals', () => {
    expect(isDashboardEligibleSignal({
      primary_source_family: 'crypto_proxy_market',
      whale_detected: false,
      reasoning: 'plain proxy setup',
      catalyst_summary: 'no external support'
    })).toBe(false);
  });

  it('allows whale-backed crypto proxy signals', () => {
    expect(isDashboardEligibleSignal({
      primary_source_family: 'crypto_proxy_market',
      whale_detected: true,
      whale_amount_usd: 12000,
      reasoning: 'proxy setup',
      catalyst_summary: 'no external support'
    })).toBe(true);
  });

  it('detects external corroboration from reasoning or catalyst summary', () => {
    expect(hasExternalProxyCorroboration({
      primary_source_family: 'crypto_proxy_market',
      reasoning: '[futures: BTC-USD confirms (+1.2% / 5m)]',
      catalyst_summary: 'no external support'
    })).toBe(true);

    expect(isDashboardEligibleSignal({
      primary_source_family: 'crypto_proxy_market',
      reasoning: 'proxy setup',
      catalyst_summary: '2 supporting families | news confirms'
    })).toBe(true);
    expect(getSignalTradeType({ primary_source_family: 'crypto_proxy_market' })).toBe('proxy');
  });
});
