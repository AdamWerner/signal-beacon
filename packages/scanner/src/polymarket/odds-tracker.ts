import { PolymarketClient } from './client.js';
import { SnapshotStore, InsertSnapshot } from '../storage/snapshot-store.js';
import { MarketStore } from '../storage/market-store.js';

export interface OddsChange {
  market_condition_id: string;
  market_slug: string;
  market_title: string;
  odds_before: number;
  odds_now: number;
  delta_pct: number;
  time_window_minutes: number;
}

export class OddsTracker {
  constructor(
    private client: PolymarketClient,
    private snapshotStore: SnapshotStore,
    private marketStore: MarketStore
  ) {}

  /**
   * Track current odds for all active markets
   */
  async trackAllMarkets(): Promise<number> {
    const markets = this.marketStore.findAll(true);
    let trackedCount = 0;

    console.log(`Tracking odds for ${markets.length} markets...`);

    for (const market of markets) {
      const success = await this.trackMarket(market.condition_id);
      if (success) {
        trackedCount++;
      }

      // Rate limiting
      await this.delay(500);
    }

    console.log(`✓ Tracked ${trackedCount} markets`);
    return trackedCount;
  }

  /**
   * Track odds for a single market
   */
  async trackMarket(conditionId: string): Promise<boolean> {
    try {
      // Fetch current prices/odds from CLOB API
      const prices = await this.client.fetchPrices(conditionId);

      if (!prices) {
        return false;
      }

      const snapshot: InsertSnapshot = {
        market_condition_id: conditionId,
        odds_yes: prices.yes,
        odds_no: prices.no,
        volume_24h: null // Can be fetched from market data if needed
      };

      this.snapshotStore.insert(snapshot);
      this.marketStore.updateLastChecked(conditionId);

      return true;
    } catch (error) {
      console.error(`Failed to track market ${conditionId}:`, error);
      return false;
    }
  }

  /**
   * Detect significant odds changes
   */
  detectSignificantChanges(
    timeWindowMinutes: number,
    thresholdPct: number
  ): OddsChange[] {
    const markets = this.marketStore.findAll(true);
    const changes: OddsChange[] = [];

    for (const market of markets) {
      const delta = this.snapshotStore.calculateDelta(
        market.condition_id,
        timeWindowMinutes
      );

      if (!delta) {
        continue; // Not enough data
      }

      if (Math.abs(delta.delta_pct) >= thresholdPct) {
        changes.push({
          market_condition_id: market.condition_id,
          market_slug: market.slug,
          market_title: market.title,
          odds_before: delta.odds_before,
          odds_now: delta.odds_now,
          delta_pct: delta.delta_pct,
          time_window_minutes: timeWindowMinutes
        });
      }
    }

    // Sort by absolute delta descending
    return changes.sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct));
  }

  /**
   * Get odds history for a market
   */
  getHistory(conditionId: string, hours = 24) {
    return this.snapshotStore.getHistory(conditionId, hours);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
