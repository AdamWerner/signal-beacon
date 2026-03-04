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
   * Track current odds for all active markets using a single bulk fetch.
   */
  async trackAllMarkets(): Promise<number> {
    const trackedMarkets = this.marketStore.findAll(true);
    if (trackedMarkets.length === 0) return 0;

    console.log(`Bulk-fetching prices for ${trackedMarkets.length} tracked markets...`);

    // Single paginated bulk fetch — already returns outcomePrices for each market
    const allMarkets = await this.client.fetchAllMarkets(true, false);

    // Build lookup: conditionId → [yesPrice, noPrice]
    const priceMap = new Map<string, [number, number]>();
    for (const market of allMarkets) {
      if (!market.conditionId || !market.outcomePrices) continue;
      try {
        const pricesArr: string[] = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices as unknown as string)
          : market.outcomePrices;
        if (!Array.isArray(pricesArr) || pricesArr.length < 2) continue;
        const yes = parseFloat(pricesArr[0]);
        const no = parseFloat(pricesArr[1]);
        if (!isNaN(yes) && !isNaN(no)) {
          priceMap.set(market.conditionId, [yes, no]);
        }
      } catch { /* skip malformed */ }
    }

    let trackedCount = 0;
    for (const market of trackedMarkets) {
      const prices = priceMap.get(market.condition_id);
      if (!prices) continue;
      this.snapshotStore.insert({
        market_condition_id: market.condition_id,
        odds_yes: prices[0],
        odds_no: prices[1],
        volume_24h: null
      });
      this.marketStore.updateLastChecked(market.condition_id);
      trackedCount++;
    }

    console.log(`✓ Tracked ${trackedCount} markets`);
    return trackedCount;
  }

  /**
   * Track odds for a single market using the Gamma numeric id for the API call.
   */
  async trackMarket(conditionId: string, gammaId: string): Promise<boolean> {
    try {
      const gammaMarket = await this.client.fetchMarket(gammaId);
      if (!gammaMarket || !gammaMarket.outcomePrices) {
        return false;
      }

      // outcomePrices is a JSON string like '["0.65","0.35"]' or already an array
      const pricesArr: string[] = typeof gammaMarket.outcomePrices === 'string'
        ? JSON.parse(gammaMarket.outcomePrices as unknown as string)
        : gammaMarket.outcomePrices;

      if (!Array.isArray(pricesArr) || pricesArr.length < 2) {
        return false;
      }

      const yes = parseFloat(pricesArr[0]);
      const no = parseFloat(pricesArr[1]);
      if (isNaN(yes) || isNaN(no)) {
        return false;
      }

      const snapshot: InsertSnapshot = {
        market_condition_id: conditionId,
        odds_yes: yes,
        odds_no: no,
        volume_24h: null
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
