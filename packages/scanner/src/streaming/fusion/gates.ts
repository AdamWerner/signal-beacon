import { FusionInputs, TradeDirection } from './types.js';

export interface GateResult {
  pass: boolean;
  reasons: string[];
  suppressReasons: string[];
}

const MAX_SPREAD_BPS = Math.max(5, parseFloat(process.env.FUSION_MAX_SPREAD_BPS || '25'));
const MIN_DEPTH_10BPS = Math.max(1, parseFloat(process.env.FUSION_MIN_DEPTH_10BPS || '7'));
const MIN_IMBALANCE_PERSISTENCE = Math.max(
  0.1,
  Math.min(0.9, parseFloat(process.env.FUSION_MIN_IMBALANCE_PERSISTENCE || '0.35'))
);
const MIN_MICRO_DIVERGENCE = Math.max(
  0.005,
  Math.min(1, parseFloat(process.env.FUSION_MIN_MICRO_DIVERGENCE || '0.02'))
);
const MIN_SIGNAL_CONFIDENCE = Math.max(0, parseFloat(process.env.FUSION_MIN_SIGNAL_CONFIDENCE || '40'));

function directionSign(direction: TradeDirection): 1 | -1 {
  return direction === 'bull' ? 1 : -1;
}

export function evaluateHardGates(inputs: FusionInputs): GateResult {
  const reasons: string[] = [];
  const suppressReasons: string[] = [];

  if (inputs.stale || !inputs.feature1s || !inputs.feature1m) {
    suppressReasons.push('streaming features unavailable or stale');
    return { pass: false, reasons, suppressReasons };
  }

  if (inputs.feature1s.spreadBps > MAX_SPREAD_BPS) {
    suppressReasons.push(`spread too wide (${inputs.feature1s.spreadBps.toFixed(1)} bps)`);
  } else {
    reasons.push(`spread ok (${inputs.feature1s.spreadBps.toFixed(1)} bps)`);
  }

  if (inputs.feature1s.depth10bps < MIN_DEPTH_10BPS) {
    suppressReasons.push(`insufficient depth10bps (${inputs.feature1s.depth10bps.toFixed(1)})`);
  } else {
    reasons.push(`depth ok (${inputs.feature1s.depth10bps.toFixed(1)})`);
  }

  const sign = directionSign(inputs.direction);
  const alignedImbalance = sign > 0
    ? inputs.feature1m.topImbalancePersistenceBull >= MIN_IMBALANCE_PERSISTENCE
    : inputs.feature1m.topImbalancePersistenceBear >= MIN_IMBALANCE_PERSISTENCE;
  if (!alignedImbalance) {
    suppressReasons.push('imbalance persistence not aligned');
  } else {
    reasons.push('imbalance persistence aligned');
  }

  const alignedMicro = sign * inputs.feature1s.normalizedMicroDivergence > MIN_MICRO_DIVERGENCE;
  if (!alignedMicro) {
    suppressReasons.push('micro-price divergence not aligned');
  } else {
    reasons.push('micro-price divergence aligned');
  }

  if (inputs.signalConfidence < MIN_SIGNAL_CONFIDENCE) {
    suppressReasons.push(`confidence floor failed (${inputs.signalConfidence} < ${MIN_SIGNAL_CONFIDENCE})`);
  }

  if ((inputs.volatilityTag || '').toLowerCase().includes('extreme')) {
    suppressReasons.push('volatility regime disqualifying (extreme)');
  }

  return {
    pass: suppressReasons.length === 0,
    reasons,
    suppressReasons
  };
}

export function evaluateSoftConfirmations(inputs: FusionInputs): { score: number; reasons: string[] } {
  if (!inputs.feature1s || !inputs.feature1m) {
    return { score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let score = 0;
  const sign = inputs.direction === 'bull' ? 1 : -1;

  if (sign * inputs.feature1s.ofiProxy > 0) {
    score += 10;
    reasons.push('OFI aligned +10');
  } else {
    score -= 8;
    reasons.push('OFI opposes -8');
  }

  if (sign * inputs.feature1s.normalizedMicroDivergence > MIN_MICRO_DIVERGENCE) {
    score += 7;
    reasons.push('microprice aligned +7');
  }

  if (inputs.feature1s.liquidityCliff) {
    score -= 8;
    reasons.push('liquidity stress -8');
  }

  if ((inputs.futuresTag || '').toLowerCase().includes('confirms')) {
    score += 4;
    reasons.push('futures confirms +4');
  } else if ((inputs.futuresTag || '').toLowerCase().includes('contradicts')) {
    score -= 5;
    reasons.push('futures contradicts -5');
  }

  if ((inputs.macroTag || '').toLowerCase().includes('impact:very_high') || (inputs.macroTag || '').toLowerCase().includes('impact:high')) {
    score += 2;
    reasons.push('macro window active +2');
  }

  if (inputs.liquidationEnabled && inputs.feature1s.liquidationBurstIntensity && inputs.feature1s.liquidationBurstIntensity > 0) {
    const liqDirection = inputs.feature1s.liquidationDirection || 'none';
    const aligned = (sign > 0 && liqDirection === 'buy') || (sign < 0 && liqDirection === 'sell');
    if (aligned) {
      score += 4;
      reasons.push('liquidation confirms +4');
    }
  }

  if (inputs.secondVenueEnabled && inputs.feature1s.secondVenueReturn5s != null) {
    if (sign * inputs.feature1s.secondVenueReturn5s > 0) {
      score += 3;
      reasons.push('second venue confirms +3');
    } else if (sign * inputs.feature1s.secondVenueReturn5s < 0) {
      score -= 3;
      reasons.push('second venue diverges -3');
    }
  }

  return { score, reasons };
}
