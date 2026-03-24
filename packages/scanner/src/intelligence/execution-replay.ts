import { CatalystStore, ExecutionReplayProfile } from '../storage/catalyst-store.js';
import { GeneratedSignal } from '../signals/types.js';

export interface ExecutionReplayAssessment {
  gate: 'open' | 'watch' | 'block' | 'unknown';
  samples: number;
  winRate30m: number;
  expectancyPct: number;
  confidenceAdjustment: number;
  note: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class ExecutionReplayService {
  constructor(private catalystStore: CatalystStore) {}

  assess(
    signal: GeneratedSignal,
    sourceFamily: string
  ): ExecutionReplayAssessment {
    const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
    const profile = this.catalystStore.getExecutionReplayProfile(
      signal.matched_asset_id,
      direction,
      sourceFamily
    );

    if (!profile) {
      return {
        gate: 'unknown',
        samples: 0,
        winRate30m: 0,
        expectancyPct: 0,
        confidenceAdjustment: 0,
        note: `replay unavailable for ${sourceFamily}`
      };
    }

    return {
      gate: profile.gate,
      samples: profile.samples,
      winRate30m: profile.win_rate_30m,
      expectancyPct: profile.expectancy_pct,
      confidenceAdjustment: this.toConfidenceAdjustment(profile),
      note:
        `${profile.source_family} replay ${profile.gate} ` +
        `(n=${profile.samples}, hit30=${(profile.win_rate_30m * 100).toFixed(0)}%, ` +
        `exp=${profile.expectancy_pct.toFixed(2)}%)`
    };
  }

  private toConfidenceAdjustment(profile: ExecutionReplayProfile): number {
    if (profile.samples < 4) return 0;
    if (profile.gate === 'open') {
      return clamp(Math.round((profile.win_rate_30m - 0.5) * 18 + (profile.expectancy_pct / 0.5)), 2, 8);
    }
    if (profile.gate === 'block') {
      return clamp(Math.round((profile.win_rate_30m - 0.5) * 18 + (profile.expectancy_pct / 0.5)), -10, -3);
    }
    if (profile.gate === 'watch') {
      return clamp(Math.round(profile.expectancy_pct / 0.6), -2, 2);
    }
    return 0;
  }
}
