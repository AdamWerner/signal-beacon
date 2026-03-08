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
  timeframesTriggered?: number; // How many of [30, 60, 240] windows triggered for this market
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
    const fetchStart = Date.now();

    // Single paginated bulk fetch - already returns outcomePrices for each market.
    const allMarkets = await this.client.fetchAllMarkets(true, false);
    console.log(
      `  Bulk fetch returned ${allMarkets.length} markets in ${((Date.now() - fetchStart) / 1000).toFixed(1)}s`
    );

    // Build lookup: conditionId -> [yesPrice, noPrice]
    const priceMap = new Map<string, [number, number]>();
    const mapBuildStart = Date.now();

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
      } catch {
        // Skip malformed rows.
      }
    }

    console.log(
      `  Built price map (${priceMap.size} markets) in ${((Date.now() - mapBuildStart) / 1000).toFixed(1)}s`
    );

    let trackedCount = 0;
    const writeStart = Date.now();

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
      trackedCount += 1;
    }

    console.log(`  Wrote ${trackedCount} snapshots in ${((Date.now() - writeStart) / 1000).toFixed(1)}s`);
    console.log(`Tracked ${trackedCount} markets`);

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

      // outcomePrices is a JSON string like '["0.65","0.35"]' or already an array.
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
   * Detect significant odds changes.
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
        continue; // Not enough data.
      }

      if (Math.abs(delta.delta_pct) >= thresholdPct) {
        const oddsNow = delta.odds_now;
        const oddsBefore = delta.odds_before;
        const absChangePp = Math.abs(oddsNow - oddsBefore);
        const midOdds = (oddsNow + oddsBefore) / 2;

        // Skip markets where both endpoints are in the noise zone (<5% or >95%).
        if ((oddsNow < 0.05 && oddsBefore < 0.05) || (oddsNow > 0.95 && oddsBefore > 0.95)) {
          continue;
        }

        // Tiered absolute floor:
        // - Near extremes (<10% or >90%): require 3pp move
        // - Mid-range (10%-90%): require 1.5pp move
        const minAbsChange = (midOdds < 0.10 || midOdds > 0.90) ? 0.03 : 0.015;
        if (absChangePp < minAbsChange) {
          continue;
        }

        changes.push({
          market_condition_id: market.condition_id,
          market_slug: market.slug,
          market_title: market.title,
          odds_before: oddsBefore,
          odds_now: oddsNow,
          delta_pct: delta.delta_pct,
          time_window_minutes: timeWindowMinutes
        });
      }
    }

    // Sort by absolute delta descending.
    return changes.sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct));
  }

  /**
   * Detect significant changes across multiple timeframes [30, 60, 240 min].
   * Markets that trigger on multiple timeframes are ranked first and carry
   * timeframesTriggered count for downstream confidence boosting.
   */
  detectMultiTimeframeChanges(thresholdPct: number): OddsChange[] {
    const windows = [30, 60, 240];
    const allChanges = new Map<string, OddsChange & { timeframesTriggered: number }>();

    for (const window of windows) {
      const changes = this.detectSignificantChanges(window, thresholdPct);
      for (const change of changes) {
        const key = change.market_condition_id;
        const existing = allChanges.get(key);
        if (existing) {
          existing.timeframesTriggered++;
          // Keep the shortest timeframe's delta (most urgent/fresh)
          if (change.time_window_minutes < existing.time_window_minutes) {
            existing.delta_pct = change.delta_pct;
            existing.odds_before = change.odds_before;
            existing.time_window_minutes = change.time_window_minutes;
          }
        } else {
          allChanges.set(key, { ...change, timeframesTriggered: 1 });
        }
      }
    }

    // Sort: multi-timeframe signals first, then by delta magnitude
    return Array.from(allChanges.values()).sort((a, b) => {
      if (b.timeframesTriggered !== a.timeframesTriggered) {
        return b.timeframesTriggered - a.timeframesTriggered;
      }
      return Math.abs(b.delta_pct) - Math.abs(a.delta_pct);
    });
  }

  /**
   * Get odds history for a market.
   */
  getHistory(conditionId: string, hours = 24) {
    return this.snapshotStore.getHistory(conditionId, hours);
  }
}
