import { describe, expect, it } from 'vitest';
import { ExecutionReplayService } from './execution-replay.js';
import { GeneratedSignal } from '../signals/types.js';

function buildSignal(): GeneratedSignal {
  return {
    id: 'sig_test',
    market_condition_id: 'cond_1',
    market_slug: 'market',
    market_title: 'Will oil surge after OPEC cuts output?',
    odds_before: 0.35,
    odds_now: 0.48,
    delta_pct: 37,
    time_window_minutes: 60,
    whale_detected: false,
    whale_amount_usd: null,
    matched_asset_id: 'oil-shell',
    matched_asset_name: 'Shell',
    polarity: 'direct',
    suggested_action: 'Consider BULL position',
    suggested_instruments: [],
    reasoning: 'test',
    confidence: 68,
    requires_judgment: false,
    deduplication_key: 'dedup',
    verification_status: 'approved',
    verification_score: 80,
    verification_reason: 'ok',
    verification_flags: [],
    verification_source: 'guard',
    verification_record: null
  };
}

describe('ExecutionReplayService', () => {
  it('blocks historically weak setups with enough samples', () => {
    const service = new ExecutionReplayService({
      getExecutionReplayProfile: () => ({
        profile_key: 'k',
        asset_id: 'oil-shell',
        direction: 'bull',
        source_family: 'macro_rates',
        samples: 12,
        win_rate_30m: 0.38,
        avg_move_30m: -0.2,
        avg_favorable_60m: 0.8,
        avg_adverse_60m: -1.4,
        expectancy_pct: -0.45,
        typical_cost_pct: 1.0,
        gate: 'block',
        updated_at: new Date().toISOString()
      })
    } as any);

    const result = service.assess(buildSignal(), 'macro_rates');
    expect(result.gate).toBe('block');
    expect(result.confidenceAdjustment).toBeLessThan(0);
  });

  it('rewards strong historically profitable setups', () => {
    const service = new ExecutionReplayService({
      getExecutionReplayProfile: () => ({
        profile_key: 'k',
        asset_id: 'oil-shell',
        direction: 'bull',
        source_family: 'geopolitical_energy',
        samples: 16,
        win_rate_30m: 0.62,
        avg_move_30m: 0.5,
        avg_favorable_60m: 1.4,
        avg_adverse_60m: -0.8,
        expectancy_pct: 0.9,
        typical_cost_pct: 0.8,
        gate: 'open',
        updated_at: new Date().toISOString()
      })
    } as any);

    const result = service.assess(buildSignal(), 'geopolitical_energy');
    expect(result.gate).toBe('open');
    expect(result.confidenceAdjustment).toBeGreaterThan(0);
  });
});
