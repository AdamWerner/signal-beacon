import { estimateExpectancyPct } from './expectancy.js';
import { evaluateHardGates, evaluateSoftConfirmations } from './gates.js';
import { computePHat, DEFAULT_FUSION_WEIGHTS, FusionWeightConfig } from './scoring.js';
import { FusionDecision, FusionInputs } from './types.js';

export interface FusionEngineConfig {
  pHatMin: number;
  expectancyMinPct: number;
  weights?: Partial<FusionWeightConfig>;
}

export class FusionEngine {
  private weights: FusionWeightConfig;

  constructor(private config: FusionEngineConfig) {
    this.weights = { ...DEFAULT_FUSION_WEIGHTS, ...(config.weights || {}) };
  }

  evaluate(inputs: FusionInputs): FusionDecision {
    const hard = evaluateHardGates(inputs);
    const soft = evaluateSoftConfirmations(inputs);
    const reasons = [...hard.reasons, ...soft.reasons];
    const suppressReasons = [...hard.suppressReasons];
    const featureFlagsUsed: string[] = [];

    if (inputs.secondVenueEnabled) featureFlagsUsed.push('enableSecondVenue');
    if (inputs.liquidationEnabled) featureFlagsUsed.push('enableLiquidations');

    if (inputs.stale || !inputs.feature1s || !inputs.feature1m) {
      return {
        signalId: inputs.signalId,
        timestamp: new Date().toISOString(),
        assetId: inputs.assetId,
        symbol: inputs.symbol,
        direction: inputs.direction,
        pHat: 0,
        expectancyHatPct: 0,
        hardPass: false,
        softScore: 0,
        reasons,
        suppressReasons: suppressReasons.length > 0 ? suppressReasons : ['streaming data unavailable'],
        featureFlagsUsed,
        decision: 'fallback_phase1'
      };
    }

    const sign = inputs.direction === 'bull' ? 1 : -1;
    const rawScore =
      (Math.abs(inputs.signalDeltaPct) * this.weights.baseSignalShock) +
      (inputs.signalConfidence * this.weights.baseConfidence) +
      ((sign * inputs.feature1s.multiLevelImbalance) * 100 * this.weights.imbalance) +
      ((sign * inputs.feature1s.ofiProxy) * this.weights.ofi) +
      ((sign * inputs.feature1s.normalizedMicroDivergence) * 100 * this.weights.microDivergence) +
      (Math.max(0, 20 - inputs.feature1s.spreadBps) * this.weights.spreadPenalty) +
      (Math.min(100, inputs.feature1s.depth10bps) * this.weights.depthBonus) -
      ((inputs.feature1s.liquidityCliff ? 20 : 0) * this.weights.liquidityCliffPenalty) +
      soft.score;

    const pHat = computePHat(rawScore);
    const expectancyHatPct = estimateExpectancyPct({
      pHat,
      tpPct: 3,
      slPct: 2,
      spreadBps: inputs.feature1s.spreadBps,
      liquidityPenaltyPct: inputs.feature1s.liquidityCliff ? 0.25 : 0.05
    });

    if (!hard.pass) {
      return {
        signalId: inputs.signalId,
        timestamp: new Date().toISOString(),
        assetId: inputs.assetId,
        symbol: inputs.symbol,
        direction: inputs.direction,
        pHat,
        expectancyHatPct,
        hardPass: false,
        softScore: soft.score,
        reasons,
        suppressReasons,
        featureFlagsUsed,
        decision: 'suppress'
      };
    }

    if (pHat < this.config.pHatMin) {
      suppressReasons.push(`p_hat below threshold (${pHat.toFixed(2)} < ${this.config.pHatMin.toFixed(2)})`);
    }
    if (expectancyHatPct < this.config.expectancyMinPct) {
      suppressReasons.push(
        `expectancy below threshold (${expectancyHatPct.toFixed(2)}% < ${this.config.expectancyMinPct.toFixed(2)}%)`
      );
    }

    return {
      signalId: inputs.signalId,
      timestamp: new Date().toISOString(),
      assetId: inputs.assetId,
      symbol: inputs.symbol,
      direction: inputs.direction,
      pHat,
      expectancyHatPct,
      hardPass: hard.pass,
      softScore: soft.score,
      reasons,
      suppressReasons,
      featureFlagsUsed,
      decision: suppressReasons.length > 0 ? 'suppress' : 'allow'
    };
  }
}

