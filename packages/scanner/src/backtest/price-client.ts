export interface PricePoint {
  timestampMs: number;
  close: number;
}

export class YahooPriceClient {
  async getSeries(symbol: string, startMs: number, endMs: number): Promise<PricePoint[]> {
    const period1 = Math.floor((startMs - 15 * 60 * 1000) / 1000);
    const period2 = Math.floor((endMs + 5 * 60 * 1000) / 1000);

    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set('interval', '1m');
    url.searchParams.set('period1', String(period1));
    url.searchParams.set('period2', String(period2));
    url.searchParams.set('includePrePost', 'true');

    try {
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PolySignal/1.0)',
          'Accept': 'application/json'
        }
      });
      if (!response.ok) {
        console.warn(`[price] Yahoo ${response.status} for ${symbol}: ${url.toString()}`);
        return [];
      }

      const data = await response.json() as any;
      const result = data?.chart?.result?.[0];
      if (!result) {
        console.warn(`[price] No chart result for ${symbol} (error: ${JSON.stringify(data?.chart?.error)})`);
        return [];
      }
      const timestamps = result?.timestamp as number[] | undefined;
      const closes = result?.indicators?.quote?.[0]?.close as Array<number | null> | undefined;
      if (!Array.isArray(timestamps) || !Array.isArray(closes)) {
        console.warn(`[price] Missing timestamps/closes for ${symbol}`);
        return [];
      }

      const points: PricePoint[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) continue;
        points.push({
          timestampMs: timestamps[i] * 1000,
          close
        });
      }
      return points;
    } catch {
      return [];
    }
  }
}
