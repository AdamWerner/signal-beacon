import { OrderBookLevel } from '../orderbook/orderbook.js';

export function computeMicroPrice(bestBid: OrderBookLevel | null, bestAsk: OrderBookLevel | null): number | null {
  if (!bestBid || !bestAsk) return null;
  const denom = bestBid.size + bestAsk.size;
  if (denom <= 0) return null;
  return ((bestAsk.price * bestBid.size) + (bestBid.price * bestAsk.size)) / denom;
}

export function computeNormalizedMicroDivergence(
  microPrice: number | null,
  mid: number | null,
  spread: number | null
): number {
  if (microPrice == null || mid == null || spread == null || spread <= 0) return 0;
  return (microPrice - mid) / spread;
}

