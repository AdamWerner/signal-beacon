import Database from 'better-sqlite3';
import { ASSET_TO_TICKER, getAssetDisplayName, getAssetTicker } from '../utils/ticker-map.js';
import { SourceCatalyst } from './types.js';

const INTRADAY_MOVE_THRESHOLD_PCT = 1.5;
const STRONG_MOVE_THRESHOLD_PCT = 2.5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CHECKS_PER_CYCLE = 10;

interface CachedAlert {
  expiresAt: number;
  alert: PriceAlert | null;
}

interface PriceAlert {
  ticker: string;
  assetId: string;
  changePct: number;
  currentPrice: number;
  previousClose: number;
  volume: number;
  avgVolume: number;
}

export class PriceAlertScanner {
  private cache = new Map<string, CachedAlert>();
  private rotationOffset = 0;

  constructor(private db?: Database.Database) {}

  async scan(prioritizedAssetIds: string[] = []): Promise<SourceCatalyst[]> {
    const catalysts: SourceCatalyst[] = [];
    const allAssets = Object.keys(ASSET_TO_TICKER);
    const priority = new Set(prioritizedAssetIds);
    const prioritized = allAssets.filter(assetId => priority.has(assetId));
    const nonPriority = allAssets.filter(assetId => !priority.has(assetId));
    const rotated = [
      ...prioritized,
      ...nonPriority.slice(this.rotationOffset),
      ...nonPriority.slice(0, this.rotationOffset)
    ];

    this.rotationOffset = (this.rotationOffset + 3) % Math.max(1, nonPriority.length || 1);

    for (const assetId of rotated.slice(0, MAX_CHECKS_PER_CYCLE)) {
      const ticker = getAssetTicker(assetId);
      if (!ticker) continue;

      const cached = this.cache.get(assetId);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.alert) catalysts.push(this.alertToCatalyst(cached.alert));
        continue;
      }

      try {
        const alert = await this.checkPrice(assetId, ticker);
        this.cache.set(assetId, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          alert
        });
        if (alert) {
          catalysts.push(this.alertToCatalyst(alert));
        }
      } catch {
        this.cache.set(assetId, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          alert: null
        });
      }
    }

    this.persist(catalysts);
    return catalysts;
  }

  private async checkPrice(assetId: string, ticker: string): Promise<PriceAlert | null> {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
    url.searchParams.set('interval', '1d');
    url.searchParams.set('range', '5d');

    const resp = await fetch(url.toString(), {
      headers: { 'User-Agent': 'PolySignal/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) return null;

    const data = await resp.json() as any;
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    const quotes = result?.indicators?.quote?.[0];
    const closes = quotes?.close as number[] | undefined;
    const volumes = quotes?.volume as number[] | undefined;
    if (!meta || !Array.isArray(closes) || closes.length < 2 || !Array.isArray(volumes)) {
      return null;
    }

    const currentPrice = meta.regularMarketPrice ?? closes[closes.length - 1];
    const previousClose = meta.chartPreviousClose ?? closes[closes.length - 2];
    if (!currentPrice || !previousClose || previousClose <= 0) return null;

    const changePct = ((currentPrice - previousClose) / previousClose) * 100;
    if (Math.abs(changePct) < INTRADAY_MOVE_THRESHOLD_PCT) {
      return null;
    }

    const todayVol = volumes[volumes.length - 1] ?? 0;
    const historical = volumes.slice(0, -1).filter(volume => typeof volume === 'number' && volume > 0);
    const avgVolume = historical.length > 0
      ? historical.reduce((sum, volume) => sum + volume, 0) / historical.length
      : 0;

    return {
      ticker,
      assetId,
      changePct,
      currentPrice,
      previousClose,
      volume: todayVol,
      avgVolume
    };
  }

  private alertToCatalyst(alert: PriceAlert): SourceCatalyst {
    const direction = alert.changePct > 0 ? 'bull' : 'bear';
    const strong = Math.abs(alert.changePct) >= STRONG_MOVE_THRESHOLD_PCT;
    const volRatio = alert.avgVolume > 0 ? alert.volume / alert.avgVolume : 1;

    return {
      sourceType: 'finviz_volume',
      sourceKey: `price_alert:${alert.assetId}:${new Date().toISOString().split('T')[0]}:${direction}`,
      ticker: alert.ticker,
      assetId: alert.assetId,
      assetName: getAssetDisplayName(alert.assetId),
      title: `${alert.ticker} ${direction === 'bull' ? 'up' : 'down'} ${Math.abs(alert.changePct).toFixed(1)}% intraday`,
      body: `Price: ${alert.currentPrice.toFixed(2)} (prev close: ${alert.previousClose.toFixed(2)}), volume ${volRatio.toFixed(1)}x avg`,
      directionHint: direction,
      urgency: strong ? 'high' : 'medium',
      timestamp: new Date().toISOString(),
      sourceWeight: strong ? 1.2 : 1.0,
      metadata: {
        changePct: alert.changePct,
        volumeRatio: volRatio,
        totalBoost: strong ? 6 : 3
      }
    };
  }

  private persist(catalysts: SourceCatalyst[]): void {
    if (!this.db || catalysts.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO finviz_catalysts (
        ticker, asset_id, catalyst_type, title, direction_hint, urgency, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const catalyst of catalysts) {
      try {
        stmt.run(
          catalyst.ticker,
          catalyst.assetId,
          'price_alert',
          catalyst.title,
          catalyst.directionHint,
          catalyst.urgency,
          catalyst.timestamp
        );
      } catch {
        // Ignore duplicate / transient persistence failures.
      }
    }
  }
}
