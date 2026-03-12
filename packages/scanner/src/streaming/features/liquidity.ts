export function computeSpreadBps(mid: number | null, spread: number | null): number {
  if (mid == null || spread == null || mid <= 0) return 0;
  return (spread / mid) * 10_000;
}

export function computeDepthDropRate(currentDepth: number, previousDepth: number): number {
  if (previousDepth <= 0) return 0;
  return (previousDepth - currentDepth) / previousDepth;
}

export function detectLiquidityCliff(depthDropRate: number, spreadBps: number): boolean {
  return depthDropRate >= 0.35 || spreadBps >= 20;
}

