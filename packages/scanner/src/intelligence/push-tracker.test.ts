import { describe, expect, it } from 'vitest';
import { calculateNetMaxFavorable } from './push-tracker.js';

describe('calculateNetMaxFavorable', () => {
  it('subtracts round-trip execution cost from max favorable move', () => {
    expect(calculateNetMaxFavorable(4, 0.008)).toBeCloseTo(3.2, 6);
  });
});
