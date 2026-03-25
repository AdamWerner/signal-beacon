import { CatalystStore, SourceFamilyDiagnostic } from '../storage/catalyst-store.js';

export interface SourceDiagnosticAssessment {
  sourceFamily: string;
  samples: number;
  reliabilityScore: number;
  expectancyPct: number;
  confidenceAdjustment: number;
  note: string;
}

export interface SourceHealth {
  name: string;
  lastSuccess: string | null;
  lastFailure: string | null;
  consecutiveFailures: number;
  catalystsLast24h: number;
  avgLatencyMs: number;
  backedOffUntil: string | null;
}

interface SourceHealthState {
  name: string;
  lastSuccess: string | null;
  lastFailure: string | null;
  consecutiveFailures: number;
  totalLatencyMs: number;
  latencySamples: number;
  catalystEvents: Array<{ timestampMs: number; count: number }>;
  backedOffUntilMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class SourceDiagnosticsService {
  private lastRefreshAt = 0;
  private sourceHealth = new Map<string, SourceHealthState>();

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

  shouldBackoff(name: string): boolean {
    const state = this.sourceHealth.get(name);
    return Boolean(state && state.backedOffUntilMs > Date.now());
  }

  recordSourceScan(name: string, input: {
    success: boolean;
    latencyMs: number;
    catalystCount: number;
  }): void {
    const now = Date.now();
    const state = this.getOrCreateHealthState(name);
    state.totalLatencyMs += Math.max(0, input.latencyMs);
    state.latencySamples += 1;
    state.catalystEvents.push({ timestampMs: now, count: Math.max(0, input.catalystCount) });
    state.catalystEvents = state.catalystEvents.filter(event => event.timestampMs >= now - (24 * 60 * 60 * 1000));

    if (input.success) {
      state.lastSuccess = new Date(now).toISOString();
      state.consecutiveFailures = 0;
      state.backedOffUntilMs = 0;
      return;
    }

    state.lastFailure = new Date(now).toISOString();
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= 5 && state.backedOffUntilMs < now) {
      state.backedOffUntilMs = now + (30 * 60 * 1000);
    }
  }

  getSourceHealth(): SourceHealth[] {
    const now = Date.now();
    return Array.from(this.sourceHealth.values())
      .map(state => ({
        name: state.name,
        lastSuccess: state.lastSuccess,
        lastFailure: state.lastFailure,
        consecutiveFailures: state.consecutiveFailures,
        catalystsLast24h: state.catalystEvents
          .filter(event => event.timestampMs >= now - (24 * 60 * 60 * 1000))
          .reduce((sum, event) => sum + event.count, 0),
        avgLatencyMs: state.latencySamples > 0 ? state.totalLatencyMs / state.latencySamples : 0,
        backedOffUntil: state.backedOffUntilMs > now ? new Date(state.backedOffUntilMs).toISOString() : null
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private toAdjustment(row: SourceFamilyDiagnostic): number {
    if (row.samples < 4) return 0;
    return clamp(
      Math.round(((row.reliability_score - 0.5) * 14) + (row.expectancy_pct / 1.2)),
      -6,
      6
    );
  }

  private getOrCreateHealthState(name: string): SourceHealthState {
    const existing = this.sourceHealth.get(name);
    if (existing) return existing;

    const created: SourceHealthState = {
      name,
      lastSuccess: null,
      lastFailure: null,
      consecutiveFailures: 0,
      totalLatencyMs: 0,
      latencySamples: 0,
      catalystEvents: [],
      backedOffUntilMs: 0
    };
    this.sourceHealth.set(name, created);
    return created;
  }
}
