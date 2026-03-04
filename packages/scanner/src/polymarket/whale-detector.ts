import { PolymarketClient } from './client.js';
import { Trade } from './types.js';
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
    const detections: WhaleDetection[] = [];

    console.log(`Scanning ${markets.length} markets for whale activity (threshold: $${this.thresholdUsd.toLocaleString()})...`);

    // Process in parallel batches of 10 with 200ms between batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
      const batch = markets.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(m => this.detectForMarket(m.condition_id)));
      for (const whales of results) detections.push(...whales);
      if (i + BATCH_SIZE < markets.length) await this.delay(200);
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
