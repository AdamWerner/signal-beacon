import { PolymarketClient } from './client.js';
import { GammaMarket } from './types.js';
import { OntologyEngine } from '../correlation/ontology.js';
import { MarketStore, InsertMarket } from '../storage/market-store.js';

export interface DiscoveryResult {
  totalScanned: number;
  newMarketsAdded: number;
  marketsUpdated: number;
  marketsResolved: number;
  duration: number;
}

export class MarketDiscoverer {
  constructor(
    private client: PolymarketClient,
    private ontology: OntologyEngine,
    private store: MarketStore,
    private relevanceThreshold: number = 0.4
  ) {}

  /**
   * Discover and track new relevant markets
   */
  async discoverMarkets(): Promise<DiscoveryResult> {
    const startTime = Date.now();
    console.log('Starting Polymarket market discovery...');

    // Fetch all active markets
    const markets = await this.client.fetchAllMarkets(true, false);
    console.log(`Fetched ${markets.length} active markets from Polymarket`);

    let newCount = 0;
    let updatedCount = 0;

    for (const market of markets) {
      const existing = this.store.findByConditionId(market.condition_id);

      // Match market to ontology assets
      const matches = this.ontology.matchMarket(
        market.question,
        market.description || null,
        market.category || null
      );

      if (matches.length === 0) {
        continue; // No relevant matches
      }

      const relevanceScore = this.ontology.calculateRelevance(matches);

      if (relevanceScore < this.relevanceThreshold) {
        continue; // Below threshold
      }

      const matchedAssetIds = matches.map(m => m.assetId);

      const marketData: InsertMarket = {
        condition_id: market.condition_id,
        slug: market.slug,
        title: market.question,
        description: market.description || null,
        category: market.category || null,
        matched_asset_ids: matchedAssetIds,
        relevance_score: relevanceScore,
        volume: parseFloat(market.volume) || null,
        liquidity: parseFloat(market.liquidity || '0') || null
      };

      if (!existing) {
        newCount++;
        console.log(`  ✓ New market: "${market.question.substring(0, 60)}..." (assets: ${matchedAssetIds.join(', ')})`);
      } else {
        updatedCount++;
      }

      this.store.insert(marketData);
    }

    // Check for resolved markets (markets that are now closed)
    const resolvedCount = await this.markResolvedMarkets();

    const duration = Date.now() - startTime;

    console.log(`\n✓ Discovery complete in ${(duration / 1000).toFixed(1)}s`);
    console.log(`  Scanned: ${markets.length}`);
    console.log(`  New: ${newCount}`);
    console.log(`  Updated: ${updatedCount}`);
    console.log(`  Resolved: ${resolvedCount}`);

    return {
      totalScanned: markets.length,
      newMarketsAdded: newCount,
      marketsUpdated: updatedCount,
      marketsResolved: resolvedCount,
      duration
    };
  }

  /**
   * Check tracked markets for resolution
   */
  private async markResolvedMarkets(): Promise<number> {
    const trackedMarkets = this.store.findAll(true);
    let resolvedCount = 0;

    for (const tracked of trackedMarkets) {
      const market = await this.client.fetchMarket(tracked.condition_id);

      if (!market || market.closed) {
        this.store.markAsResolved(tracked.condition_id);
        resolvedCount++;
        console.log(`  → Marked as resolved: "${tracked.title.substring(0, 60)}..."`);
      }

      // Rate limit
      await this.delay(500);
    }

    return resolvedCount;
  }

  /**
   * Get discovery statistics
   */
  getStats() {
    return this.store.getStats();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
