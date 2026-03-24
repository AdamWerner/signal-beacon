import { CatalystStore, SourceFamilyDiagnostic } from '../storage/catalyst-store.js';

export interface SourceDiagnosticAssessment {
  sourceFamily: string;
  samples: number;
  reliabilityScore: number;
  expectancyPct: number;
  confidenceAdjustment: number;
  note: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class SourceDiagnosticsService {
  private lastRefreshAt = 0;

  constructor(private catalystStore: CatalystStore) {}

  refreshIfStale(maxAgeMs = 30 * 60 * 1000): void {
    if (Date.now() - this.lastRefreshAt < maxAgeMs) return;
    this.catalystStore.refreshSourceFamilyDiagnostics();
    this.catalystStore.refreshExecutionReplayProfiles();
    this.lastRefreshAt = Date.now();
  }

  assess(sourceFamily: string): SourceDiagnosticAssessment {
    const diagnostic = this.catalystStore.getSourceFamilyDiagnostics(200)
      .find(row => row.source_family === sourceFamily);

    if (!diagnostic) {
      return {
        sourceFamily,
        samples: 0,
        reliabilityScore: 0.5,
        expectancyPct: 0,
        confidenceAdjustment: 0,
        note: `source diagnostics unavailable for ${sourceFamily}`
      };
    }

    return {
      sourceFamily,
      samples: diagnostic.samples,
      reliabilityScore: diagnostic.reliability_score,
      expectancyPct: diagnostic.expectancy_pct,
      confidenceAdjustment: this.toAdjustment(diagnostic),
      note:
        `${sourceFamily} diagnostics ` +
        `(n=${diagnostic.samples}, rel=${diagnostic.reliability_score.toFixed(2)}, ` +
        `exp=${diagnostic.expectancy_pct.toFixed(2)}%)`
    };
  }

  private toAdjustment(row: SourceFamilyDiagnostic): number {
    if (row.samples < 4) return 0;
    return clamp(
      Math.round(((row.reliability_score - 0.5) * 14) + (row.expectancy_pct / 1.2)),
      -6,
      6
    );
  }
}
