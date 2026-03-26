import { TRADING_HOURS, getAssetMarket, getStockholmClockPartsAt } from './trading-hours.js';

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

function getSessionSpreadMultiplier(assetId: string): number {
  const market = getAssetMarket(assetId);
  const { minutes, day } = getStockholmClockPartsAt(new Date());
  if (day === 0 || day === 6) {
    return 1;
  }

  const cfg = TRADING_HOURS[market];
  const openMinutes = cfg.open.hour * 60 + cfg.open.minute;
  const closeMinutes = cfg.close.hour * 60 + cfg.close.minute;
  const isOpen = minutes >= openMinutes && minutes < closeMinutes;
  const minutesFromOpen = Math.max(0, minutes - openMinutes);
  const minutesToClose = Math.max(0, closeMinutes - minutes);
  const minutesToOpen = minutes < openMinutes ? openMinutes - minutes : null;
  const sessionLength = Math.max(1, closeMinutes - openMinutes);
  const sessionProgressPct = isOpen ? (minutesFromOpen / sessionLength) * 100 : 0;

  if (isOpen) {
    if (minutesToClose <= 15 || sessionProgressPct <= 6) {
      return 2;
    }
    if (minutesToClose <= 45 || sessionProgressPct <= 15) {
      return 1.5;
    }
    return 1;
  }

  if (minutesToOpen !== null && minutesToOpen <= 15) {
    return 2;
  }
  if (minutesToOpen !== null && minutesToOpen <= 45) {
    return 1.5;
  }
  return 1;
}

export function estimateExecutionCost(assetId: string, leverage = 3): {
  roundTripCostPct: number;
  feasible: boolean;
  note: string;
} {
  const baseSpreadPct = TYPICAL_SPREADS[assetId] ?? TYPICAL_SPREADS.default;
  const spreadMultiplier = getSessionSpreadMultiplier(assetId);
  const leveragePenalty = leverage > 3 ? 1 + ((leverage - 3) * 0.08) : 1;
  const spreadPct = baseSpreadPct * spreadMultiplier * leveragePenalty;
  const roundTripCostPct = spreadPct * 2;
  const feasible = roundTripCostPct < 0.015;

  return {
    roundTripCostPct,
    feasible,
    note: feasible
      ? `Spread ~${(spreadPct * 100).toFixed(1)}%, round-trip ~${(roundTripCostPct * 100).toFixed(1)}% - OK`
      : `Spread ~${(spreadPct * 100).toFixed(1)}%, round-trip ~${(roundTripCostPct * 100).toFixed(1)}% - EXPENSIVE, consider skipping`
  };
}
