const TYPICAL_SPREADS: Record<string, number> = {
  'defense-saab': 0.005,
  'steel-ssab': 0.008,
  'mining-boliden': 0.008,
  'telecom-ericsson': 0.006,
  'gaming-evolution': 0.007,
  'retail-hm': 0.008,
  omx30: 0.004,
  sp500: 0.005,
  nasdaq100: 0.005,
  'oil-equinor': 0.008,
  'oil-shell': 0.01,
  'ai-nvidia': 0.008,
  'ev-tesla': 0.01,
  'defense-lockheed': 0.012,
  default: 0.01
};

export function estimateExecutionCost(assetId: string, leverage = 3): {
  roundTripCostPct: number;
  feasible: boolean;
  note: string;
} {
  const spreadPct = TYPICAL_SPREADS[assetId] ?? TYPICAL_SPREADS.default;
  const roundTripCostPct = spreadPct * 2;
  const feasible = roundTripCostPct < 0.015;

  return {
    roundTripCostPct,
    feasible,
    note: feasible
      ? `Spread ~${(spreadPct * 100).toFixed(1)}%, round-trip ~${(roundTripCostPct * 100).toFixed(1)}% — OK`
      : `Spread ~${(spreadPct * 100).toFixed(1)}%, round-trip ~${(roundTripCostPct * 100).toFixed(1)}% — EXPENSIVE, consider skipping`
  };
}

