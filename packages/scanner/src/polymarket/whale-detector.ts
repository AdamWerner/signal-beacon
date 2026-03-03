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
    private thresholdUsd: number = 25000
  ) {}

  /**
   * Detect whale trades for all active markets
   */
  async detectWhales(): Promise<WhaleDetection[]> {
    const markets = this.marketStore.findAll(true);
    const detections: WhaleDetection[] = [];

    console.log(`Scanning ${markets.length} markets for whale activity...`);

    for (const market of markets) {
      const whales = await this.detectForMarket(market.condition_id);
      detections.push(...whales);

      // Rate limiting
      await this.delay(500);
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
        const sizeUsd = parseFloat(trade.size) * parseFloat(trade.price);

        if (sizeUsd >= this.thresholdUsd) {
          // Deduplication: skip if we've already stored this trade
          if (trade.id && this.whaleStore.existsByTradeId(trade.id)) {
            continue;
          }

          const detection: WhaleDetection = {
            market_condition_id: conditionId,
            market_title: market.title,
            timestamp: new Date(trade.timestamp * 1000).toISOString(),
            side: trade.side,
            size_usd: sizeUsd,
            price_at_trade: parseFloat(trade.price)
          };

          detections.push(detection);

          const whaleEvent: InsertWhaleEvent = {
            market_condition_id: conditionId,
            timestamp: detection.timestamp,
            side: trade.side,
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
