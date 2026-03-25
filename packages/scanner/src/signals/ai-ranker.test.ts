import { describe, expect, it } from 'vitest';
import { deduplicateSignalsForTopTrades } from './ai-ranker.js';
import { Signal } from '../storage/signal-store.js';

function buildSignal(overrides: Partial<Signal>): Signal {
  return {
    id: 'sig_default',
    signal_origin: 'polymarket',
    timestamp: '2026-03-05T10:00:00.000Z',
    market_condition_id: 'm1',
    market_slug: 'market-1',
    market_title: 'Will event happen?',
    odds_before: 0.3,
    odds_now: 0.45,
    delta_pct: 50,
    time_window_minutes: 60,
    whale_detected: false,
    whale_amount_usd: null,
    matched_asset_id: 'sp500',
    matched_asset_name: 'S&P 500',
    polarity: 'direct',
    suggested_action: 'Consider BULL position',
    suggested_instruments: '[]',
    reasoning: 'Test',
    confidence: 60,
    requires_judgment: false,
    deduplication_key: 'k1',
    ai_analysis: null,
    verification_status: 'approved',
    verification_score: 80,
    verification_reason: 'ok',
    verification_flags: '[]',
    verification_source: 'claude',
    verification_record: null,
    verification_updated_at: '2026-03-05T10:00:00.000Z',
    push_sent_at: null,
    push_channel: null,
    status: 'new',
    ...overrides
  };
}

describe('AI top-trade dedup', () => {
  it('keeps max one top-trade entry per asset across markets', () => {
    const signals: Signal[] = [
      buildSignal({
        id: 'sig_sp500_high',
        market_condition_id: 'market_a',
        matched_asset_id: 'sp500',
        matched_asset_name: 'S&P 500',
        confidence: 78
      }),
      buildSignal({
        id: 'sig_sp500_low',
        market_condition_id: 'market_b',
        matched_asset_id: 'sp500',
        matched_asset_name: 'S&P 500',
        confidence: 62
      }),
      buildSignal({
        id: 'sig_nasdaq',
        market_condition_id: 'market_c',
        matched_asset_id: 'nasdaq100',
        matched_asset_name: 'NASDAQ 100',
        confidence: 70
      })
    ];

    const deduped = deduplicateSignalsForTopTrades(signals);
    const uniqueAssetIds = new Set(deduped.map(signal => signal.matched_asset_id));

    expect(deduped.length).toBe(uniqueAssetIds.size);
    expect(deduped.find(signal => signal.id === 'sig_sp500_high')).toBeTruthy();
    expect(deduped.find(signal => signal.id === 'sig_sp500_low')).toBeFalsy();
  });
});
