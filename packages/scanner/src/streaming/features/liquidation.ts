import { BinanceLiquidationTick } from '../collectors/binance-futures-ws.js';

export interface LiquidationContext {
  burstIntensity: number;
  direction: 'buy' | 'sell' | 'mixed' | 'none';
  clusteringScore: number;
}

export function computeLiquidationContext(
  events: BinanceLiquidationTick[],
  lookbackMs = 60_000
): LiquidationContext {
  const cutoff = Date.now() - lookbackMs;
  const recent = events.filter(event => event.timestamp >= cutoff);
  if (recent.length === 0) {
    return { burstIntensity: 0, direction: 'none', clusteringScore: 0 };
  }

  const buySize = recent
    .filter(event => event.side === 'buy')
    .reduce((sum, event) => sum + event.quantity, 0);
  const sellSize = recent
    .filter(event => event.side === 'sell')
    .reduce((sum, event) => sum + event.quantity, 0);

  const totalSize = buySize + sellSize;
  const direction = buySize > sellSize * 1.15
    ? 'buy'
    : sellSize > buySize * 1.15
      ? 'sell'
      : 'mixed';

  const avgGapMs = recent.length <= 1
    ? lookbackMs
    : (recent[recent.length - 1].timestamp - recent[0].timestamp) / Math.max(1, recent.length - 1);
  const clusteringScore = Math.max(0, Math.min(1, 1 - (avgGapMs / lookbackMs)));
  const burstIntensity = totalSize / Math.max(1, lookbackMs / 1000);

  return {
    burstIntensity,
    direction,
    clusteringScore
  };
}

