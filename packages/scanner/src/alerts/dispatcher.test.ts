import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
const isMarketOpenMock = vi.fn();
const getAssetMarketMock = vi.fn();
const estimateExecutionCostMock = vi.fn();

vi.mock('./homeassistant.js', () => ({
  HomeAssistantAlert: vi.fn().mockImplementation(() => ({
    send: sendMock
  }))
}));

vi.mock('../intelligence/trading-hours.js', () => ({
  getAssetMarket: (...args: unknown[]) => getAssetMarketMock(...args),
  isMarketOpen: (...args: unknown[]) => isMarketOpenMock(...args),
  TRADING_HOURS: {
    swedish: {
      open: { hour: 9, minute: 0 },
      close: { hour: 17, minute: 30 },
      preMarketPush: { hour: 8, minute: 45 }
    },
    us: {
      open: { hour: 15, minute: 30 },
      close: { hour: 22, minute: 0 },
      preMarketPush: { hour: 15, minute: 15 }
    }
  }
}));

vi.mock('../intelligence/execution-feasibility.js', () => ({
  estimateExecutionCost: (...args: unknown[]) => estimateExecutionCostMock(...args)
}));

vi.mock('../utils/ai-budget.js', () => ({
  shouldDoDeepVerify: () => false
}));

vi.mock('../utils/local-ai-cli.js', () => ({
  runLocalAiPrompt: vi.fn()
}));

import { AlertDispatcher, extractCatalystSourceFamilies } from './dispatcher.js';
import type { GeneratedSignal } from '../signals/types.js';

function buildSignal(overrides: Partial<GeneratedSignal> = {}): GeneratedSignal {
  return {
    id: overrides.id ?? 'signal-1',
    signal_origin: overrides.signal_origin ?? 'polymarket',
    market_condition_id: overrides.market_condition_id ?? 'market-1',
    market_slug: overrides.market_slug ?? 'market-1',
    market_title: overrides.market_title ?? 'Regular signal',
    odds_before: overrides.odds_before ?? 0.42,
    odds_now: overrides.odds_now ?? 0.68,
    delta_pct: overrides.delta_pct ?? 26,
    time_window_minutes: overrides.time_window_minutes ?? 30,
    whale_detected: overrides.whale_detected ?? true,
    whale_amount_usd: overrides.whale_amount_usd ?? 15000,
    matched_asset_id: overrides.matched_asset_id ?? 'oil-equinor',
    matched_asset_name: overrides.matched_asset_name ?? 'Equinor',
    polarity: overrides.polarity ?? 'direct',
    suggested_action: overrides.suggested_action ?? 'BULL Equinor',
    suggested_instruments: overrides.suggested_instruments ?? [],
    reasoning: overrides.reasoning ?? 'Test reasoning [execution: ok]',
    confidence: overrides.confidence ?? 80,
    requires_judgment: overrides.requires_judgment ?? false,
    deduplication_key: overrides.deduplication_key ?? 'market-1:oil-equinor',
    verification_status: overrides.verification_status ?? 'approved',
    verification_score: overrides.verification_score ?? 80,
    verification_reason: overrides.verification_reason ?? 'ok',
    verification_flags: overrides.verification_flags ?? [],
    verification_source: overrides.verification_source ?? 'guard',
    verification_record: overrides.verification_record ?? null,
    primary_source_family: overrides.primary_source_family,
    catalyst_score: overrides.catalyst_score,
    catalyst_summary: overrides.catalyst_summary,
    execution_replay_gate: overrides.execution_replay_gate,
    execution_replay_expectancy_pct: overrides.execution_replay_expectancy_pct,
    execution_replay_samples: overrides.execution_replay_samples,
    execution_replay_win_rate: overrides.execution_replay_win_rate,
    fusion_p_hat: overrides.fusion_p_hat,
    fusion_expectancy_pct: overrides.fusion_expectancy_pct,
    fusion_decision: overrides.fusion_decision,
    fusion_reasons: overrides.fusion_reasons,
    fusion_suppress_reasons: overrides.fusion_suppress_reasons,
    confirming_source_families: overrides.confirming_source_families,
    source_count_override: overrides.source_count_override ?? null
  };
}

function createDispatcher(options: {
  market?: 'swedish' | 'us';
  signalStore?: Record<string, any>;
  onSignalsPushed?: ReturnType<typeof vi.fn>;
} = {}) {
  const signalStore = {
    findFiltered: vi.fn(() => []),
    updatePushGateOutcome: vi.fn(),
    recordShadowPush: vi.fn(),
    getPushPolicyConfig: vi.fn(() => null),
    countDistinctApprovedMarketsForAssetDirection: vi.fn(() => 0),
    getDirectionalPushPerformance: vi.fn(() => null),
    getSourceFamilyPerformance: vi.fn(() => null),
    getPushPerformancePolicy: vi.fn(() => null),
    ...options.signalStore
  };
  const onSignalsPushed = options.onSignalsPushed ?? vi.fn();

  const dispatcher = new AlertDispatcher({
    minConfidence: 50,
    verificationRequiredForPush: true,
    homeAssistant: {
      enabled: true,
      url: 'http://ha.local',
      token: 'token',
      notifyService: 'notify.mobile_app',
      minConfidence: 65
    },
    signalStore: signalStore as any,
    onSignalsPushed
  });

  getAssetMarketMock.mockImplementation(() => options.market ?? 'us');
  isMarketOpenMock.mockReturnValue(true);
  estimateExecutionCostMock.mockReturnValue({
    feasible: true,
    note: 'test execution ok',
    roundTripCostPct: 0.01
  });

  (dispatcher as any).getPushQualityBlockReason = vi.fn(() => null);
  (dispatcher as any).evaluateExecutionReplayGate = vi.fn(() => ({ allowed: true, reason: 'ok' }));
  (dispatcher as any).evaluateRegimeShiftGate = vi.fn(() => ({ allowed: true, reason: 'ok' }));
  (dispatcher as any).evaluatePushPerformanceGate = vi.fn(() => ({ allowed: true, reason: 'ok' }));
  (dispatcher as any).evaluateEvidenceGate = vi.fn(() => ({ allowed: true, reason: 'score=5/3 reinforcement=0' }));
  (dispatcher as any).deepVerify = vi.fn(async () => null);
  (dispatcher as any).dispatchLegacy = vi.fn(async () => undefined);

  return { dispatcher, signalStore, onSignalsPushed };
}

describe('extractCatalystSourceFamilies', () => {
  it('reads structured families and ignores unrelated reasoning tags', () => {
    const signal = {
      confirming_source_families: ['news', 'technical']
    };
    const types = extractCatalystSourceFamilies(signal);
    expect(types.has('macro')).toBe(false);
    expect(types.has('news')).toBe(true);
    expect(types.has('technical')).toBe(true);
    expect(types.size).toBe(2);
  });

  it('reads rss_news family from structured field', () => {
    const signal = {
      confirming_source_families: ['rss_news']
    };
    const types = extractCatalystSourceFamilies(signal);
    expect(types.has('rss_news')).toBe(true);
    expect(types.size).toBe(1);
  });

  it('returns empty set when confirming_source_families is absent', () => {
    const signal = {
      confirming_source_families: undefined
    };
    const types = extractCatalystSourceFamilies(signal);
    expect(types.size).toBe(0);
  });
});

describe('AlertDispatcher shadow mode', () => {
  const envKeys = ['PUSH_SHADOW_MODE', 'SHADOW_CANARY_OVERRIDE', 'SHADOW_BYPASS_GATES', 'DRY_RUN'];
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    sendMock.mockReset();
    sendMock.mockResolvedValue(true);
    isMarketOpenMock.mockReset();
    getAssetMarketMock.mockReset();
    estimateExecutionCostMock.mockReset();
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('suppresses HA send and records a shadow push when all gates pass', async () => {
    process.env.PUSH_SHADOW_MODE = 'true';
    const { dispatcher, signalStore, onSignalsPushed } = createDispatcher();

    const result = await dispatcher.dispatchBatch([buildSignal()]);

    expect(result).toEqual({ pushedSwedish: 0, pushedUs: 0, brewed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
    expect(signalStore.recordShadowPush).toHaveBeenCalledTimes(1);
    expect(signalStore.recordShadowPush).toHaveBeenCalledWith(
      'signal-1',
      expect.objectContaining({
        pushGateOutcome: 'shadow_push: all gates passed, HA suppressed',
        shadowBypassedGates: []
      })
    );
    expect(onSignalsPushed).not.toHaveBeenCalled();
  });

  it('bypasses market_closed in shadow mode and preserves the bypass audit trail', async () => {
    process.env.PUSH_SHADOW_MODE = 'true';
    const { dispatcher, signalStore } = createDispatcher();
    isMarketOpenMock.mockReturnValue(false);

    await dispatcher.dispatchBatch([buildSignal()]);

    expect(signalStore.recordShadowPush).toHaveBeenCalledTimes(1);
    expect(signalStore.recordShadowPush).toHaveBeenCalledWith(
      'signal-1',
      expect.objectContaining({
        shadowBypassedGates: ['market_closed']
      })
    );
    expect(signalStore.updatePushGateOutcome).not.toHaveBeenCalledWith(
      'signal-1',
      expect.stringContaining('market_closed:')
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('bypasses execution_feasibility in shadow mode and records the canonical bypass name', async () => {
    process.env.PUSH_SHADOW_MODE = 'true';
    const { dispatcher, signalStore } = createDispatcher();
    estimateExecutionCostMock.mockReturnValue({
      feasible: false,
      note: 'Spread ~1.0%, round-trip ~2.0% - EXPENSIVE, consider skipping',
      roundTripCostPct: 0.02
    });

    await dispatcher.dispatchBatch([buildSignal()]);

    expect(signalStore.recordShadowPush).toHaveBeenCalledTimes(1);
    expect(signalStore.recordShadowPush).toHaveBeenCalledWith(
      'signal-1',
      expect.objectContaining({
        shadowBypassedGates: ['execution_feasibility']
      })
    );
    expect(signalStore.updatePushGateOutcome).not.toHaveBeenCalledWith(
      'signal-1',
      expect.stringContaining('execution:')
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('still rejects low-confidence signals in shadow mode', async () => {
    process.env.PUSH_SHADOW_MODE = 'true';
    const { dispatcher, signalStore } = createDispatcher({ market: 'us' });

    const result = await dispatcher.dispatchBatch([
      buildSignal({
        confidence: 60,
        id: 'signal-low'
      })
    ]);

    expect(result).toEqual({ pushedSwedish: 0, pushedUs: 0, brewed: 0 });
    expect(signalStore.recordShadowPush).not.toHaveBeenCalled();
    expect(signalStore.updatePushGateOutcome).toHaveBeenCalledWith(
      'signal-low',
      expect.stringContaining('thresholds:')
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('still rejects deep-verify failures in shadow mode', async () => {
    process.env.PUSH_SHADOW_MODE = 'true';
    const { dispatcher, signalStore } = createDispatcher();
    (dispatcher as any).deepVerify = vi.fn(async () => ({
      verdict: 'reject',
      confidence_adjustment: 0,
      reason: 'stale thesis',
      flags: []
    }));

    const result = await dispatcher.dispatchBatch([buildSignal()]);

    expect(result).toEqual({ pushedSwedish: 0, pushedUs: 0, brewed: 0 });
    expect(signalStore.recordShadowPush).not.toHaveBeenCalled();
    expect(signalStore.updatePushGateOutcome).toHaveBeenCalledWith(
      'signal-1',
      'deep_verify_reject: stale thesis'
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('allows the live HA canary path when SHADOW_CANARY_OVERRIDE is set', async () => {
    process.env.PUSH_SHADOW_MODE = 'true';
    process.env.SHADOW_CANARY_OVERRIDE = 'true';
    const { dispatcher, signalStore, onSignalsPushed } = createDispatcher();

    const canary = buildSignal({
      id: 'canary-1',
      market_title: 'POLYSIGNAL LIVE-PUSH CANARY - NOT A REAL SIGNAL',
      reasoning: 'Weekly live-push canary only. [canary:test]'
    });

    const result = await dispatcher.dispatchBatch([canary]);

    expect(result).toEqual({ pushedSwedish: 0, pushedUs: 1, brewed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(signalStore.recordShadowPush).not.toHaveBeenCalled();
    expect(signalStore.updatePushGateOutcome).toHaveBeenCalledWith(
      'canary-1',
      'pushed: all gates passed'
    );
    expect(onSignalsPushed).toHaveBeenCalledWith(['canary-1'], 'us');
  });

  it('preserves default non-shadow HA behavior', async () => {
    const { dispatcher, signalStore, onSignalsPushed } = createDispatcher();

    const result = await dispatcher.dispatchBatch([buildSignal()]);

    expect(result).toEqual({ pushedSwedish: 0, pushedUs: 1, brewed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(signalStore.recordShadowPush).not.toHaveBeenCalled();
    expect(signalStore.updatePushGateOutcome).toHaveBeenCalledWith(
      'signal-1',
      'pushed: all gates passed'
    );
    expect(onSignalsPushed).toHaveBeenCalledWith(['signal-1'], 'us');
  });
});
