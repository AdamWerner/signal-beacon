import { createHash } from 'crypto';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { getAssetMarket, isMarketOpen } from '../intelligence/trading-hours.js';
import { SignalStore } from '../storage/signal-store.js';
import { getAiBudgetMode } from '../utils/ai-budget.js';
import { ASSET_TO_TICKER, getAssetDisplayName, getAssetTicker } from '../utils/ticker-map.js';
import { SourceCatalyst } from './types.js';

const require = createRequire(import.meta.url);
const technicalIndicators = require('fast-technical-indicators') as typeof import('fast-technical-indicators');
const { atr, bollingerbands, macd, rsi } = technicalIndicators;

const ACTIVE_MARKET_YAHOO_CALLS = 8;
const DORMANT_MARKET_YAHOO_CALLS = 3;
const POSITIVE_CACHE_TTL_MS = 2 * 60 * 1000;
const EMPTY_CACHE_TTL_MS = 5 * 60 * 1000;
const LOOKBACK_BARS = 120;

interface YahooBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CachedTechnicalScan {
  expiresAt: number;
  catalysts: SourceCatalyst[];
}

interface BreakoutCondition {
  key: string;
  direction: 'bull' | 'bear';
  urgency: 'high' | 'medium';
  boost: number;
  description: string;
}

export interface TechnicalSnapshot {
  ticker: string;
  assetId: string;
  timestamp: string;
  price: number;
  rsi14: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  bbPosition: number | null;
  atr14: number | null;
  volumeRatio: number;
}

function hashValue(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], target: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(target * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

function round(value: number | null, digits = 4): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function getDirectionLabel(direction: 'bull' | 'bear'): string {
  return direction === 'bull' ? 'breakout' : 'breakdown';
}

export class TechnicalScanner {
  private cache = new Map<string, CachedTechnicalScan>();
  private rotationOffset = 0;

  constructor(
    private db?: Database.Database,
    private signalStore?: SignalStore
  ) {}

  async scan(
    prioritizedAssetIds: string[] = [],
    options: { fullCoverage?: boolean } = {}
  ): Promise<SourceCatalyst[]> {
    const catalysts: SourceCatalyst[] = [];
    const maxCalls = getAiBudgetMode() === 'active' ? ACTIVE_MARKET_YAHOO_CALLS : DORMANT_MARKET_YAHOO_CALLS;
    const orderedAssets = this.selectAssets(prioritizedAssetIds);
    const assets = options.fullCoverage ? orderedAssets : orderedAssets.slice(0, maxCalls);

    for (const assetId of assets) {
      const ticker = getAssetTicker(assetId);
      if (!ticker) continue;

      const cached = this.cache.get(assetId);
      if (cached && cached.expiresAt > Date.now()) {
        catalysts.push(...cached.catalysts);
        continue;
      }

      try {
        const bars = await this.fetchBars(ticker);
        const result = this.buildCatalysts(assetId, ticker, bars);
        this.cache.set(assetId, {
          expiresAt: Date.now() + (result.catalysts.length > 0 ? POSITIVE_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS),
          catalysts: result.catalysts
        });
        catalysts.push(...result.catalysts);
      } catch (error) {
        console.warn(`[technical] scan failed for ${assetId}/${ticker}: ${String(error)}`);
      }
    }

    return catalysts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  private selectAssets(prioritizedAssetIds: string[]): string[] {
    return this.selectAssetsSmartly(prioritizedAssetIds).filter(assetId => Boolean(getAssetTicker(assetId)));
  }

  private selectAssetsSmartly(prioritizedAssetIds: string[]): string[] {
    const supported = Object.keys(ASSET_TO_TICKER);
    const openAssets = new Set(supported.filter(assetId => isMarketOpen(getAssetMarket(assetId))));
    const priority = new Set(prioritizedAssetIds);
    const recentSignals = this.signalStore
      ? this.signalStore.findFiltered({ hours: 4, limit: 100 })
      : [];
    const rotated = [
      ...supported.slice(this.rotationOffset),
      ...supported.slice(0, this.rotationOffset)
    ];
    const rotationOrder = new Map(rotated.map((assetId, index) => [assetId, index]));

    const scored = supported.map(assetId => {
      let score = 0;
      if (openAssets.has(assetId)) score += 50;
      if (priority.has(assetId)) score += 100;

      const recentCount = recentSignals.filter(signal => signal.matched_asset_id === assetId).length;
      score += recentCount * 10;

      const cached = this.cache.get(assetId);
      if (cached && cached.expiresAt > Date.now()) score -= 50;

      return {
        assetId,
        score,
        rotationRank: rotationOrder.get(assetId) ?? Number.MAX_SAFE_INTEGER
      };
    });

    this.rotationOffset = (this.rotationOffset + DORMANT_MARKET_YAHOO_CALLS) % Math.max(1, supported.length);
    return scored
      .sort((a, b) => (b.score - a.score) || (a.rotationRank - b.rotationRank))
      .map(entry => entry.assetId);
  }

  private async fetchBars(ticker: string): Promise<YahooBar[]> {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
    url.searchParams.set('interval', '1m');
    url.searchParams.set('range', '1d');
    url.searchParams.set('includePrePost', 'true');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PolySignal/1.0)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      throw new Error(`Yahoo ${response.status}`);
    }

    const data = await response.json() as any;
    const result = data?.chart?.result?.[0];
    const timestamps = result?.timestamp as number[] | undefined;
    const quote = result?.indicators?.quote?.[0];
    const opens = quote?.open as Array<number | null> | undefined;
    const highs = quote?.high as Array<number | null> | undefined;
    const lows = quote?.low as Array<number | null> | undefined;
    const closes = quote?.close as Array<number | null> | undefined;
    const volumes = quote?.volume as Array<number | null> | undefined;

    if (!Array.isArray(timestamps) || !Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) {
      return [];
    }

    const bars: YahooBar[] = [];
    for (let index = 0; index < timestamps.length; index += 1) {
      const high = highs[index];
      const low = lows[index];
      const close = closes[index];
      const open = opens?.[index];
      if (
        typeof high !== 'number' ||
        typeof low !== 'number' ||
        typeof close !== 'number' ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close) ||
        high <= 0 ||
        low <= 0 ||
        close <= 0
      ) {
        continue;
      }

      bars.push({
        timestamp: timestamps[index] * 1000,
        open: typeof open === 'number' && Number.isFinite(open) && open > 0 ? open : close,
        high,
        low,
        close,
        volume: typeof volumes?.[index] === 'number' && Number.isFinite(volumes[index] as number) ? Math.max(0, volumes[index] as number) : 0
      });
    }

    if (bars.length === 0) return [];

    const cutoff = Date.now() - (2 * 60 * 60 * 1000);
    const recent = bars.filter(bar => bar.timestamp >= cutoff);
    return (recent.length >= 40 ? recent : bars).slice(-LOOKBACK_BARS);
  }

  private buildCatalysts(assetId: string, ticker: string, bars: YahooBar[]): {
    catalysts: SourceCatalyst[];
    snapshot: TechnicalSnapshot | null;
  } {
    if (bars.length < 35) {
      return { catalysts: [], snapshot: null };
    }

    const closes = bars.map(bar => bar.close);
    const highs = bars.map(bar => bar.high);
    const lows = bars.map(bar => bar.low);
    const volumes = bars.map(bar => bar.volume);
    const lastBar = bars[bars.length - 1];
    const prevBar = bars[bars.length - 2];
    if (!lastBar || !prevBar) {
      return { catalysts: [], snapshot: null };
    }

    const rsiSeries = rsi({ period: 14, values: closes });
    const macdSeries = macd({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9
    });
    const bbSeries = bollingerbands({
      period: 20,
      values: closes,
      stdDev: 2
    });
    const atrSeries = atr({
      period: 14,
      high: highs,
      low: lows,
      close: closes
    });

    const currentRsi = rsiSeries.at(-1) ?? null;
    const prevRsi = rsiSeries.at(-2) ?? null;
    const currentMacd = macdSeries.at(-1);
    const prevMacd = macdSeries.at(-2);
    const currentBb = bbSeries.at(-1);
    const bbHistory = bbSeries.slice(-100).map(item => item.width).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const currentAtr = atrSeries.at(-1) ?? null;

    const avgVolume20 = average(volumes.slice(-21, -1).filter(value => Number.isFinite(value)));
    const volumeRatio = avgVolume20 > 0 ? lastBar.volume / avgVolume20 : 0;
    const baseBar = bars[bars.length - 6] ?? prevBar;
    const move5mPct = baseBar?.close > 0 ? ((lastBar.close - baseBar.close) / baseBar.close) * 100 : 0;
    const currentBbWidth = typeof currentBb?.width === 'number' ? currentBb.width : null;
    const squeezeThreshold = percentile(bbHistory.slice(0, -1), 0.2);
    const inSqueeze = currentBbWidth !== null && squeezeThreshold > 0 && currentBbWidth < squeezeThreshold;

    const snapshot: TechnicalSnapshot = {
      ticker,
      assetId,
      timestamp: new Date(lastBar.timestamp).toISOString(),
      price: round(lastBar.close, 6) ?? lastBar.close,
      rsi14: round(currentRsi),
      macdSignal: round(currentMacd?.signal ?? null),
      macdHistogram: round(currentMacd?.histogram ?? null),
      bbUpper: round(currentBb?.upper ?? null),
      bbLower: round(currentBb?.lower ?? null),
      bbWidth: round(currentBbWidth),
      bbPosition: (
        typeof currentBb?.upper === 'number' &&
        typeof currentBb?.lower === 'number' &&
        currentBb.upper > currentBb.lower
      )
        ? round((lastBar.close - currentBb.lower) / (currentBb.upper - currentBb.lower))
        : null,
      atr14: round(currentAtr),
      volumeRatio: round(volumeRatio) ?? volumeRatio
    };

    const conditions: BreakoutCondition[] = [];
    if (prevRsi !== null && currentRsi !== null) {
      if (prevRsi > 30 && currentRsi <= 30) {
        conditions.push({
          key: 'rsi_cross_below_30',
          direction: 'bear',
          urgency: 'medium',
          boost: 3,
          description: `RSI crossed below 30 (${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)})`
        });
      }
      if (prevRsi < 70 && currentRsi >= 70) {
        conditions.push({
          key: 'rsi_cross_above_70',
          direction: 'bull',
          urgency: 'medium',
          boost: 3,
          description: `RSI crossed above 70 (${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)})`
        });
      }
    }
    if (currentRsi !== null) {
      if (currentRsi > 60 && prevRsi !== null && currentRsi > prevRsi + 2) {
        conditions.push({
          key: 'rsi_bull_momentum',
          direction: 'bull',
          urgency: 'medium',
          boost: 2,
          description: `RSI momentum bullish (${currentRsi.toFixed(1)}, rising)`
        });
      }
      if (currentRsi < 40 && prevRsi !== null && currentRsi < prevRsi - 2) {
        conditions.push({
          key: 'rsi_bear_momentum',
          direction: 'bear',
          urgency: 'medium',
          boost: 2,
          description: `RSI momentum bearish (${currentRsi.toFixed(1)}, falling)`
        });
      }
    }

    const currentHistogram = typeof currentMacd?.histogram === 'number' ? currentMacd.histogram : null;
    const prevHistogram = typeof prevMacd?.histogram === 'number' ? prevMacd.histogram : null;
    if (prevHistogram !== null && currentHistogram !== null) {
      if (prevHistogram <= 0 && currentHistogram > 0) {
        conditions.push({
          key: 'macd_positive_cross',
          direction: 'bull',
          urgency: 'high',
          boost: 5,
          description: `MACD histogram turned positive (${prevHistogram.toFixed(4)} -> ${currentHistogram.toFixed(4)})`
        });
      }
      if (prevHistogram >= 0 && currentHistogram < 0) {
        conditions.push({
          key: 'macd_negative_cross',
          direction: 'bear',
          urgency: 'high',
          boost: 5,
          description: `MACD histogram turned negative (${prevHistogram.toFixed(4)} -> ${currentHistogram.toFixed(4)})`
        });
      }

      const histChange = Math.abs(currentHistogram) - Math.abs(prevHistogram);
      if (currentHistogram > 0 && histChange > 0 && Math.abs(currentHistogram) > 0.05) {
        conditions.push({
          key: 'macd_bull_expanding',
          direction: 'bull',
          urgency: 'medium',
          boost: 3,
          description: `MACD histogram expanding bullish (${currentHistogram.toFixed(4)})`
        });
      }
      if (currentHistogram < 0 && histChange > 0 && Math.abs(currentHistogram) > 0.05) {
        conditions.push({
          key: 'macd_bear_expanding',
          direction: 'bear',
          urgency: 'medium',
          boost: 3,
          description: `MACD histogram expanding bearish (${currentHistogram.toFixed(4)})`
        });
      }
    }

    if (typeof currentBb?.upper === 'number' && typeof currentBb?.lower === 'number') {
      if (lastBar.close > currentBb.upper && volumeRatio > 1.2) {
        conditions.push({
          key: 'bollinger_upper_breakout',
          direction: 'bull',
          urgency: 'high',
          boost: 8,
          description: `Price broke above upper Bollinger band with ${volumeRatio.toFixed(2)}x volume`
        });
      }
      if (lastBar.close < currentBb.lower && volumeRatio > 1.2) {
        conditions.push({
          key: 'bollinger_lower_breakdown',
          direction: 'bear',
          urgency: 'high',
          boost: 8,
          description: `Price broke below lower Bollinger band with ${volumeRatio.toFixed(2)}x volume`
        });
      }
    }

    if (volumeRatio > 2 && Math.abs(move5mPct) > 0.5) {
      const direction = move5mPct > 0 ? 'bull' : 'bear';
      conditions.push({
        key: 'volume_momentum',
        direction,
        urgency: 'high',
        boost: 6,
        description: `Volume ${volumeRatio.toFixed(2)}x average with ${move5mPct.toFixed(2)}% move over 5m`
      });
    }

    const grouped = {
      bull: conditions.filter(condition => condition.direction === 'bull'),
      bear: conditions.filter(condition => condition.direction === 'bear')
    };
    const bullScore = grouped.bull.reduce((sum, condition) => sum + condition.boost, 0);
    const bearScore = grouped.bear.reduce((sum, condition) => sum + condition.boost, 0);

    let selectedDirection: 'bull' | 'bear' | null = null;
    let selectedConditions: BreakoutCondition[] = [];
    let totalBoost = 0;

    if (bullScore > 0 || bearScore > 0) {
      if (bullScore === bearScore && bullScore > 0) {
        selectedDirection = null;
      } else if (bullScore > bearScore) {
        selectedDirection = 'bull';
        selectedConditions = grouped.bull;
        totalBoost = bullScore;
      } else {
        selectedDirection = 'bear';
        selectedConditions = grouped.bear;
        totalBoost = bearScore;
      }
    }

    const breakoutTriggered = selectedConditions.some(condition =>
      condition.key.includes('breakout') || condition.key.includes('breakdown') || condition.key === 'volume_momentum'
    );
    if (selectedDirection && breakoutTriggered && inSqueeze) {
      totalBoost += 5;
      selectedConditions = [
        ...selectedConditions,
        {
          key: 'bollinger_squeeze_amplifier',
          direction: selectedDirection,
          urgency: 'high',
          boost: 5,
          description: `Bollinger squeeze amplifier (width ${currentBbWidth?.toFixed(4) ?? 'n/a'} below 20th percentile)`
        }
      ];
    }

    this.persistSnapshot(snapshot, selectedConditions, selectedDirection);

    if (!selectedDirection || totalBoost <= 0) {
      return { catalysts: [], snapshot };
    }

    const urgency = selectedConditions.some(condition => condition.urgency === 'high') ? 'high' : 'medium';
    const assetName = getAssetDisplayName(assetId);
    const catalyst: SourceCatalyst = {
      sourceType: 'technical_breakout',
      sourceKey: `technical:${assetId}:${selectedDirection}:${hashValue(selectedConditions.map(condition => condition.key).join('|'))}:${snapshot.timestamp.slice(0, 16)}`,
      ticker,
      assetId,
      assetName,
      title: `${assetName} technical ${getDirectionLabel(selectedDirection)}`,
      body: `${selectedConditions.map(condition => condition.description).join(' | ')}`,
      directionHint: selectedDirection,
      urgency,
      timestamp: snapshot.timestamp,
      sourceWeight: clamp(1 + (totalBoost / 30), 1, 1.45),
      metadata: {
        totalBoost,
        volumeRatio: snapshot.volumeRatio,
        move5mPct: round(move5mPct),
        squeeze: inSqueeze,
        conditions: selectedConditions.map(condition => ({
          key: condition.key,
          boost: condition.boost,
          description: condition.description
        })),
        snapshot
      }
    };

    return { catalysts: [catalyst], snapshot };
  }

  private persistSnapshot(
    snapshot: TechnicalSnapshot,
    conditions: BreakoutCondition[],
    direction: 'bull' | 'bear' | null
  ): void {
    if (!this.db) return;

    try {
      this.db.prepare(`
        INSERT INTO technical_snapshots (
          asset_id, ticker, timestamp, price, rsi14, macd_histogram,
          bb_width, bb_position, volume_ratio, breakout_type, breakout_direction
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.assetId,
        snapshot.ticker,
        snapshot.timestamp,
        snapshot.price,
        snapshot.rsi14,
        snapshot.macdHistogram,
        snapshot.bbWidth,
        snapshot.bbPosition,
        snapshot.volumeRatio,
        conditions.map(condition => condition.key).join(',') || null,
        direction
      );
    } catch (error) {
      if (!/technical_snapshots/i.test(String(error))) {
        console.warn(`[technical] snapshot persistence failed for ${snapshot.assetId}: ${String(error)}`);
      }
    }
  }
}
