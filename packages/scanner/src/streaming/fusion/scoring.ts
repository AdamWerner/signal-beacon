export interface FusionWeightConfig {
  baseSignalShock: number;
  baseConfidence: number;
  imbalance: number;
  ofi: number;
  microDivergence: number;
  spreadPenalty: number;
  depthBonus: number;
  liquidityCliffPenalty: number;
}

export const DEFAULT_FUSION_WEIGHTS: FusionWeightConfig = {
  baseSignalShock: 0.4,
  baseConfidence: 0.2,
  imbalance: 0.15,
  ofi: 0.1,
  microDivergence: 0.1,
  spreadPenalty: 0.08,
  depthBonus: 0.07,
  liquidityCliffPenalty: 0.12
};

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function computePHat(rawScore: number): number {
  const normalized = rawScore / 100;
  return Math.max(0, Math.min(1, logistic(normalized)));
}

