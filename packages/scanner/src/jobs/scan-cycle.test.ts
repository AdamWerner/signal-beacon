import { describe, expect, it } from 'vitest';
import { ScanCycleJob } from './scan-cycle.js';

function createJob(): ScanCycleJob {
  return new ScanCycleJob(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe('ScanCycleJob catalyst family grouping', () => {
  it('collapses technical plus price alerts into one price-action family', () => {
    const job = createJob() as any;
    const labels = job.describeCatalystFamilies([
      { sourceType: 'technical_breakout' } as any,
      { sourceType: 'finviz_volume' } as any
    ]);

    expect(labels).toEqual(['price action']);
  });

  it('keeps macro independent from price-action confirmation', () => {
    const job = createJob() as any;
    const labels = job.describeCatalystFamilies([
      { sourceType: 'technical_breakout' } as any,
      { sourceType: 'finviz_volume' } as any,
      { sourceType: 'econ_surprise' } as any
    ]);

    expect(new Set(labels)).toEqual(new Set(['price action', 'macro']));
  });
});
