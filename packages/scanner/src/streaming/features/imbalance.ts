import { OrderBookLevel } from '../orderbook/orderbook.js';

export function computeTopOfBookImbalance(bestBidSize: number, bestAskSize: number): number {
  const denom = bestBidSize + bestAskSize;
  if (denom <= 0) return 0;
  return (bestBidSize - bestAskSize) / denom;
}

export function computeMultiLevelImbalance(
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  levels = 10
): number {
  const bidDepth = bids.slice(0, levels).reduce((sum, level) => sum + level.size, 0);
  const askDepth = asks.slice(0, levels).reduce((sum, level) => sum + level.size, 0);
  const denom = bidDepth + askDepth;
  if (denom <= 0) return 0;
  return (bidDepth - askDepth) / denom;
}

