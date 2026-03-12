import { describe, expect, it } from 'vitest';
import { simulateBarrierOutcome } from './microstructure-backtest.js';

describe('microstructure barrier simulation', () => {
  it('returns win when TP hit and SL not hit', () => {
    const result = simulateBarrierOutcome(
      {
        favorable_peak_60m_pct: 3.5,
        adverse_peak_60m_pct: -1,
        move_60m_pct: 0.5
      },
      'worst_case'
    );
    expect(result.outcome).toBe('win');
    expect(result.pnlPct).toBe(3);
  });

  it('returns loss when SL hit and TP not hit', () => {
    const result = simulateBarrierOutcome(
      {
        favorable_peak_60m_pct: 1,
        adverse_peak_60m_pct: -2.5,
        move_60m_pct: -1
      },
      'random'
    );
    expect(result.outcome).toBe('loss');
    expect(result.pnlPct).toBe(-2);
  });

  it('uses worst-case precedence when both barriers touched', () => {
    const result = simulateBarrierOutcome(
      {
        favorable_peak_60m_pct: 3.8,
        adverse_peak_60m_pct: -2.2,
        move_60m_pct: 0
      },
      'worst_case'
    );
    expect(result.outcome).toBe('loss');
    expect(result.pnlPct).toBe(-2);
    expect(result.holdMinutes).toBeGreaterThanOrEqual(17);
  });
});

