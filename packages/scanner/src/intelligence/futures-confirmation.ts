import { GeneratedSignal } from '../signals/types.js';
import { getAssetTicker } from '../utils/ticker-map.js';

export type FuturesSignalAlignment = 'confirms' | 'contradicts' | 'flat';

export interface FuturesConfirmationResult {
  symbol: string;
  return5mPct: number;
  alignment: FuturesSignalAlignment;
  adjustment: number;
}

const FUTURES_MAP: Record<string, string> = {
  sp500: 'ES=F',
  nasdaq100: 'NQ=F',
  omx30: '^OMXS30',
  'oil-equinor': 'CL=F',
  'oil-shell': 'CL=F',
  'oil-exxon': 'CL=F',
  'oil-conocophillips': 'CL=F',
  'defense-saab': '^OMXS30',
  'defense-rheinmetall': '^GDAXI',
  'defense-lockheed': 'ES=F',
  'ai-nvidia': 'NQ=F',
  'ev-tesla': 'NQ=F',
  'mining-boliden': '^OMXS30',
  'steel-ssab': '^OMXS30',
  'shipping-zim': 'CL=F',
  'crypto-coinbase': 'BTC-USD'
};

interface CachedReturn {
  value: number;
  updatedAt: number;
}

export class FuturesConfirmationService {
  private cache = new Map<string, CachedReturn>();

  async confirm(signal: GeneratedSignal): Promise<FuturesConfirmationResult | null> {
    const symbol = FUTURES_MAP[signal.matched_asset_id] || getAssetTicker(signal.matched_asset_id);
    if (!symbol) {
      return null;
    }

    const return5mPct = await this.getReturn5m(symbol);
    const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
    const threshold = 0.15;

    let alignment: FuturesSignalAlignment = 'flat';
    let adjustment = 0;
    if (Math.abs(return5mPct) >= threshold) {
      const futuresBullish = return5mPct > 0;
      const signalBullish = direction === 'bull';
      if (futuresBullish === signalBullish) {
        alignment = 'confirms';
        adjustment = 5;
      } else {
        alignment = 'contradicts';
        adjustment = -8;
      }
    }

    return {
      symbol,
      return5mPct,
      alignment,
      adjustment
    };
  }

  private async getReturn5m(symbol: string): Promise<number> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.updatedAt < 5 * 60 * 1000) {
      return cached.value;
    }

    const value = await this.fetchReturn5m(symbol);
    this.cache.set(symbol, { value, updatedAt: Date.now() });
    return value;
  }

  private async fetchReturn5m(symbol: string): Promise<number> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'PolySignal/1.0' },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) return 0;

      const data = await response.json() as any;
      const result = data?.chart?.result?.[0];
      const timestamps = result?.timestamp as number[] | undefined;
      const closes = result?.indicators?.quote?.[0]?.close as Array<number | null> | undefined;
      if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length === 0) {
        return 0;
      }

      const points: Array<{ ts: number; close: number }> = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (typeof close === 'number' && Number.isFinite(close) && close > 0) {
          points.push({ ts: timestamps[i] * 1000, close });
        }
      }

      if (points.length < 3) return 0;

      const now = Date.now();
      const recentPoints = points.filter(point => now - point.ts <= 15 * 60 * 1000);
      const series = recentPoints.length >= 3 ? recentPoints : points.slice(-15);
      const last = series[series.length - 1];
      const targetTs = last.ts - 5 * 60 * 1000;
      let base = series[0];
      for (const point of series) {
        if (point.ts <= targetTs) {
          base = point;
        } else {
          break;
        }
      }

      if (!base || !last || base.close <= 0) return 0;
      return ((last.close - base.close) / base.close) * 100;
    } catch {
      return 0;
    }
  }
}
