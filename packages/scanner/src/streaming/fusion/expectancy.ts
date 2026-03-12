export interface ExpectancyInputs {
  pHat: number;
  tpPct: number;
  slPct: number;
  spreadBps: number;
  liquidityPenaltyPct: number;
}

export function estimateExpectancyPct(inputs: ExpectancyInputs): number {
  const gross = (inputs.pHat * inputs.tpPct) - ((1 - inputs.pHat) * inputs.slPct);
  const spreadCostPct = (inputs.spreadBps / 10_000) * 2;
  return gross - spreadCostPct - inputs.liquidityPenaltyPct;
}

