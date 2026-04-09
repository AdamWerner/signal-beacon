import { describe, expect, it } from 'vitest';

// Pure function extracted from WhaleDetector.detectForMarket for isolated testing.
// The actual logic lives at whale-detector.ts lines 118-122.
function deriveDirection(side: string, outcome: string | undefined): 'YES' | 'NO' {
  const sideRaw = String(side ?? '').toUpperCase();
  const outcomeRaw = String(outcome ?? 'YES').toUpperCase();
  const isBuy = sideRaw === 'BUY';
  const isYesToken = outcomeRaw === 'YES';
  return (isBuy === isYesToken) ? 'YES' : 'NO';
}

describe('whale direction: side × outcome XOR', () => {
  it('BUY Yes → YES (bullish)', () => {
    expect(deriveDirection('BUY', 'Yes')).toBe('YES');
  });

  it('SELL Yes → NO (bearish — selling the YES token)', () => {
    expect(deriveDirection('SELL', 'Yes')).toBe('NO');
  });

  it('BUY No → NO (bearish — buying the NO token)', () => {
    expect(deriveDirection('BUY', 'No')).toBe('NO');
  });

  it('SELL No → YES (bullish — selling the NO token = covering short)', () => {
    expect(deriveDirection('SELL', 'No')).toBe('YES');
  });

  it('missing outcome defaults to YES token (backwards-compat)', () => {
    // Old trades may lack the outcome field; default treats them as YES-token trades
    expect(deriveDirection('BUY', undefined)).toBe('YES');
    expect(deriveDirection('SELL', undefined)).toBe('NO');
  });
});
