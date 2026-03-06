import { PolymarketClient } from './client.js';
import { GammaMarket } from './types.js';
import { OntologyEngine } from '../correlation/ontology.js';
import { MarketStore, InsertMarket } from '../storage/market-store.js';

// Markets matching these patterns are entertainment/gambling with no stock-price signal value
export const NOISE_PATTERNS: RegExp[] = [
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
  // Crypto meme / token noise
  /\$[A-Z]{2,10}\s+reach\s+\$/i,
  /listed on binance/i,
  /listed on coinbase/i,
  /memecoin/i,
  /meme coin/i,
  /token (launch|listing|price)/i,
  /nft (floor|price|volume)/i,
  // Streaming / social media
  /will .+ (stream|viewers|viewership)/i,
  /youtube|twitch|tiktok/i,
  // Entertainment
  /\b(superbowl|super bowl|oscar|grammy|emmy)\b/i,
  /box office/i,
  /album sales/i,
  /\bdating\b/i,
  /baby|pregnant|marriage|divorce/i,
  /reality\s*tv/i,
  /will .+ die /i,
  /onlyfans/i,
  /mukbang/i,
  // Entertainment / celebrity
  /bridgerton/i,
  /release an? (album|single|ep|song)/i,
  /\b(film|movie|season \d|episode)\b/i,
  /taylor swift|beyonce|drake|kanye|rihanna/i,
  /celebrity|famous|influencer/i,
  /\b(nba|nfl|nhl|mlb|fifa|champions league)\b/i,
  /will .+ (score|win|beat|defeat|qualify)/i,
  /\bpenguin\b/i,
  /\bmemecoin\b|\bshitcoin\b/i,
  /\$[A-Z]{3,10} (hit|reach|touch|cross) \$/i,
  // Music charts (mention streaming services but are NOT about the company)
  /be the (top|\#\d+) (song|artist|track|album|show|movie) on/i,
  /monthly (spotify|apple music) listeners/i,
  /top spotify artist/i,
  // Podcast / media appearances (not market-moving)
  /appear on .+ (podcast|show|stream)/i,
  /\b(podcast|episode|interview|livestream)\b.*(by|before|december|january)/i,
  /uponly|bankless pod|unchained pod/i,
  // More entertainment/social noise
  /\bfollowers?\b.*\b(million|thousand|[0-9]+[mk])\b/i,
  /\bretweet|like|subscribe|view count\b/i,
  /will .+ (join|leave|sign with|transfer to)/i,
  /\b(grammy|emmy|oscar|tony|golden globe)\s*(award|winner|nominee)/i,
  /\brap\s*beef\b|\bdiss\s*track\b/i,
  /\bbreakup\b|\brelationship\b.*\bcelebrit/i,
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
      const eventSlug = market.eventSlug || market.events?.[0]?.slug || null;

      const marketData: InsertMarket = {
        condition_id: market.conditionId,
        gamma_id: market.id || null,
        slug: market.slug,
        event_slug: eventSlug,
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
   * Soft-delete already-tracked markets that match noise patterns.
   * Run once during cleanup to purge junk that was tracked before filters were tightened.
   */
  cleanupNoiseMarkets(): number {
    const markets = this.store.findAll(true);
    let removed = 0;
    for (const m of markets) {
      if (NOISE_PATTERNS.some(re => re.test(m.title))) {
        this.store.markAsResolved(m.condition_id);
        removed++;
        console.log(`  ✕ Noise cleanup: "${m.title.substring(0, 70)}"`);
      }
    }
    return removed;
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
