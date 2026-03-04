import { PolymarketClient } from './client.js';
import { GammaMarket } from './types.js';
import { OntologyEngine } from '../correlation/ontology.js';
import { MarketStore, InsertMarket } from '../storage/market-store.js';

// Markets matching these patterns are entertainment/gambling with no stock-price signal value
const NOISE_PATTERNS: RegExp[] = [
  /will .+ post \d+.+tweets/i,
  /will .+ tweet .+ times/i,
  /how many .+ tweets/i,
  /will .+ reach \d+ followers/i,
  /price of .+ on .+ at/i,
  /will .+ score \d+/i,
  /will .+ win .+ game/i,
  /temperature/i,
  /subscriber/i,
  /\bviews\b/i,
];

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
      // Skip markets missing required fields
      if (!market.conditionId || !market.slug || !market.question) {
        continue;
      }

      // Skip noise markets (entertainment/gambling with no stock-price signal value)
      const question = market.question;
      if (NOISE_PATTERNS.some(re => re.test(question))) {
        console.log(`  ⊘ Skipping noise market: "${question.substring(0, 60)}"`);
        continue;
      }

      const existing = this.store.findByConditionId(market.conditionId);

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
        condition_id: market.conditionId,
        gamma_id: market.id || null,
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

      try {
        this.store.insert(marketData);
      } catch (err) {
        console.error(`Failed to insert market "${market.question.substring(0, 60)}...":`, err);
        // continue processing remaining markets
      }
    }

    const duration = Date.now() - startTime;

    console.log(`\n✓ Discovery complete in ${(duration / 1000).toFixed(1)}s`);
    console.log(`  Scanned: ${markets.length}`);
    console.log(`  New: ${newCount}`);
    console.log(`  Updated: ${updatedCount}`);

    return {
      totalScanned: markets.length,
      newMarketsAdded: newCount,
      marketsUpdated: updatedCount,
      marketsResolved: 0,
      duration
    };
  }

  /**
   * Check tracked markets for resolution
   */
  async markResolvedMarkets(): Promise<number> {
    const trackedMarkets = this.store.findAll(true);
    let resolvedCount = 0;

    for (const tracked of trackedMarkets) {
      if (!tracked.gamma_id) {
        continue; // no numeric id yet — skip resolution check until next refresh
      }

      try {
        const market = await this.client.fetchMarket(tracked.gamma_id);

        // Only resolve if we got a successful response confirming the market is closed.
        // A null response means the fetch failed — leave the market active.
        if (market && market.closed) {
          this.store.markAsResolved(tracked.condition_id);
          resolvedCount++;
          console.log(`  → Marked as resolved: "${(tracked.title ?? tracked.condition_id).substring(0, 60)}"`);
        }
      } catch (err) {
        console.error(`Failed to check resolution for ${tracked.condition_id}:`, err);
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
