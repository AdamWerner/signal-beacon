import { describe, expect, it } from 'vitest';
import { wilsonInterval } from '../lib/wilson.js';

describe('wilsonInterval', () => {
  it('returns a wide interval for small samples', () => {
    const result = wilsonInterval(3, 5);
    expect(result.lower).toBeCloseTo(0.23, 2);
    expect(result.upper).toBeCloseTo(0.88, 2);
  });

  it('returns a tighter interval for larger samples', () => {
    const result = wilsonInterval(60, 100);
    expect(result.lower).toBeCloseTo(0.50, 2);
    expect(result.upper).toBeCloseTo(0.69, 2);
  });
});
