import { PolymarketClient } from './client.js';
import { WhaleStore, InsertWhaleEvent } from '../storage/whale-store.js';
import { MarketStore } from '../storage/market-store.js';

export interface WhaleDetection {
  market_condition_id: string;
  market_title: string;
  timestamp: string;
  side: 'YES' | 'NO';
  size_usd: number;
  price_at_trade: number;
}

export class WhaleDetector {
  /** Per-session cache: skip markets checked in the last 30 minutes to avoid 429s */
  private recentlyChecked = new Map<string, number>();

  constructor(
    private client: PolymarketClient,
    private whaleStore: WhaleStore,
    private marketStore: MarketStore,
    private thresholdUsd: number = 5000
  ) {}

  /**
   * Detect whale trades for all active markets
   */
  async detectWhales(): Promise<WhaleDetection[]> {
    const markets = this.marketStore.findAll(true);
    return this.detectForMarkets(markets.map(m => m.condition_id));
  }

  /**
   * Detect whale trades for a specific set of markets (targeted scan).
   * Prioritises by |delta_pct|, caps at 20 markets, respects 30-min per-market cache.
   */
  async detectForMarkets(
    conditionIds: string[],
    oddsChanges?: Array<{ market_condition_id: string; delta_pct: number }>
  ): Promise<WhaleDetection[]> {
    if (conditionIds.length === 0) return [];

    // Sort by |delta_pct| descending so the biggest movers are checked first
    let prioritized: string[];
    if (oddsChanges && oddsChanges.length > 0) {
      const deltaMap = new Map(oddsChanges.map(c => [c.market_condition_id, Math.abs(c.delta_pct)]));
      prioritized = conditionIds
        .filter(id => (deltaMap.get(id) ?? 0) >= 10) // skip tiny moves
        .sort((a, b) => (deltaMap.get(b) ?? 0) - (deltaMap.get(a) ?? 0))
        .slice(0, 20); // top 20 only
    } else {
      prioritized = conditionIds.slice(0, 20);
    }

    // Apply 30-minute per-session cache
    const now = Date.now();
    const CACHE_MS = 30 * 60 * 1000;
    const toCheck = prioritized.filter(id => {
      const last = this.recentlyChecked.get(id);
      return !last || now - last > CACHE_MS;
    });

    if (toCheck.length === 0) {
      console.log(`Whale check: all markets in 30-min cache, skipping.`);
      return [];
    }

    const detections: WhaleDetection[] = [];
    console.log(`Scanning ${toCheck.length} top markets for whale activity (threshold: $${this.thresholdUsd.toLocaleString()})...`);

    // Smaller batches (3) with longer delays (2s) to stay well under rate limits
    const BATCH_SIZE = 3;
    for (let i = 0; i < toCheck.length; i += BATCH_SIZE) {
      const batch = toCheck.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(id => this.detectForMarket(id)));
      for (const whales of results) detections.push(...whales);
      // Mark as checked
      for (const id of batch) this.recentlyChecked.set(id, Date.now());
      if (i + BATCH_SIZE < toCheck.length) await this.delay(2000);
    }

    console.log(`✓ Detected ${detections.length} whale trades`);
    return detections;
  }

  /**
   * Detect whale trades for a single market
   */
  async detectForMarket(conditionId: string): Promise<WhaleDetection[]> {
    try {
      const trades = await this.client.fetchTrades(conditionId, 100);

      if (trades.length === 0) {
        return [];
      }

      const market = this.marketStore.findByConditionId(conditionId);
      if (!market) {
        return [];
      }

      const detections: WhaleDetection[] = [];

      for (const trade of trades) {
        if (!trade.size || !trade.price) continue;
        const sizeUsd = parseFloat(trade.size) * parseFloat(trade.price);
        if (isNaN(sizeUsd)) continue;

        if (sizeUsd >= this.thresholdUsd) {
          // Deduplication: skip if we've already stored this trade
          if (trade.id && this.whaleStore.existsByTradeId(trade.id)) {
            continue;
          }

          // Normalize side: API may return BUY/SELL or yes/no or YES/NO
          const sideRaw = String(trade.side ?? '').toUpperCase();
          const side: 'YES' | 'NO' = (sideRaw === 'NO' || sideRaw === 'SELL') ? 'NO' : 'YES';

          const detection: WhaleDetection = {
            market_condition_id: conditionId,
            market_title: market.title,
            timestamp: new Date(trade.timestamp * 1000).toISOString(),
            side,
            size_usd: sizeUsd,
            price_at_trade: parseFloat(trade.price)
          };

          detections.push(detection);

          const whaleEvent: InsertWhaleEvent = {
            market_condition_id: conditionId,
            timestamp: detection.timestamp,
            side,
            size_usd: sizeUsd,
            price_at_trade: parseFloat(trade.price),
            odds_impact: null,
            trade_id: trade.id || null
          };

          this.whaleStore.insert(whaleEvent);

          console.log(`  🐋 Whale detected: ${market.title.substring(0, 40)}... ($${sizeUsd.toFixed(0)})`);
        }
      }

      return detections;
    } catch (error) {
      console.error(`Failed to detect whales for ${conditionId}:`, error);
      return [];
    }
  }

  /**
   * Check if a market has recent whale activity
   */
  hasRecentWhaleActivity(conditionId: string, minutes = 60): boolean {
    const whales = this.whaleStore.getRecentByMarket(conditionId, minutes);
    return whales.length > 0;
  }

  /**
   * Get recent whale activity details
   */
  getRecentWhaleActivity(conditionId: string, minutes = 60) {
    return this.whaleStore.getRecentByMarket(conditionId, minutes);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
