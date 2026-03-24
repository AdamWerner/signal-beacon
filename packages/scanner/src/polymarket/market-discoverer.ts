import { PolymarketClient } from './client.js';
import { OntologyEngine } from '../correlation/ontology.js';
import { MarketStore, InsertMarket, TrackedMarket } from '../storage/market-store.js';
import { isNoiseMarketQuestion } from './noise-filter.js';

export { NOISE_PATTERNS } from './noise-filter.js';

export interface DiscoveryResult {
  totalScanned: number;
  newMarketsAdded: number;
  marketsUpdated: number;
  marketsResolved: number;
  duration: number;
}

export interface RevalidationResult {
  resolved: number;
  updated: number;
}

export class MarketDiscoverer {
  constructor(
    private client: PolymarketClient,
    private ontology: OntologyEngine,
    private store: MarketStore,
    private relevanceThreshold: number = 0.4
  ) {}

  /**
   * Discover and track new relevant markets.
   */
  async discoverMarkets(): Promise<DiscoveryResult> {
    const startTime = Date.now();
    console.log('Starting Polymarket market discovery...');

    const markets = await this.client.fetchAllMarkets(true, false);
    console.log(`Fetched ${markets.length} active markets from Polymarket`);

    let newCount = 0;
    let updatedCount = 0;

    for (const market of markets) {
      if (!market.conditionId || !market.slug || !market.question) {
        continue;
      }

      const question = market.question;
      if (isNoiseMarketQuestion(question)) {
        const existingNoise = this.store.findByConditionId(market.conditionId);
        if (existingNoise?.is_active) {
          this.store.markAsResolved(market.conditionId);
        }
        console.log(`  [skip-noise] ${question.substring(0, 60)}`);
        continue;
      }

      const existing = this.store.findByConditionId(market.conditionId);
      const matches = this.ontology.matchMarket(
        market.question,
        market.description || null,
        market.category || null
      );

      if (matches.length === 0) {
        continue;
      }

      const relevanceScore = this.ontology.calculateRelevance(matches);
      if (relevanceScore < this.relevanceThreshold) {
        continue;
      }

      const matchedAssetIds = matches.map(match => match.assetId);
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
        newCount += 1;
        console.log(`  [new] ${market.question.substring(0, 60)}... (assets: ${matchedAssetIds.join(', ')})`);
      } else {
        updatedCount += 1;
      }

      try {
        this.store.insert(marketData);
      } catch (error) {
        console.error(`Failed to insert market \"${market.question.substring(0, 60)}...\":`, error);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`Discovery complete in ${(duration / 1000).toFixed(1)}s`);
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
   * Check tracked markets for resolution.
   */
  async markResolvedMarkets(): Promise<number> {
    const trackedMarkets = this.store.findAll(true);
    let resolvedCount = 0;

    for (const tracked of trackedMarkets) {
      if (!tracked.gamma_id) {
        continue;
      }

      try {
        const market = await this.client.fetchMarket(tracked.gamma_id);
        if (market && market.closed) {
          this.store.markAsResolved(tracked.condition_id);
          resolvedCount += 1;
          console.log(`  [resolved] ${(tracked.title ?? tracked.condition_id).substring(0, 60)}`);
        }
      } catch (error) {
        console.error(`Failed to check resolution for ${tracked.condition_id}:`, error);
      }

      await this.delay(500);
    }

    return resolvedCount;
  }

  /**
   * Soft-delete already-tracked markets that match noise patterns.
   */
  cleanupNoiseMarkets(): number {
    const markets = this.store.findAll(true);
    let removed = 0;

    for (const market of markets) {
      if (isNoiseMarketQuestion(market.title)) {
        this.store.markAsResolved(market.condition_id);
        removed += 1;
        console.log(`  [noise-cleanup] ${market.title.substring(0, 70)}`);
      }
    }

    return removed;
  }

  revalidateTrackedMarkets(): RevalidationResult {
    const markets = this.store.findAll(true);
    let resolved = 0;
    let updated = 0;

    for (const market of markets) {
      if (isNoiseMarketQuestion(market.title)) {
        this.store.markAsResolved(market.condition_id);
        resolved += 1;
        continue;
      }

      const matches = this.ontology.matchMarket(
        market.title,
        market.description || null,
        market.category || null
      );
      const relevanceScore = this.ontology.calculateRelevance(matches);

      if (matches.length === 0 || relevanceScore < this.relevanceThreshold) {
        this.store.markAsResolved(market.condition_id);
        resolved += 1;
        continue;
      }

      const nextAssetIds = matches.map(match => match.assetId);
      const currentAssetIds = this.safeJsonArray(market);
      const sameAssets =
        currentAssetIds.length === nextAssetIds.length &&
        currentAssetIds.every((assetId, index) => assetId === nextAssetIds[index]);

      if (!sameAssets || Math.abs((market.relevance_score || 0) - relevanceScore) >= 0.001) {
        this.store.updateMatching(market.condition_id, nextAssetIds, relevanceScore);
        updated += 1;
      }
    }

    return { resolved, updated };
  }

  /**
   * Get discovery statistics.
   */
  getStats() {
    return this.store.getStats();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private safeJsonArray(market: TrackedMarket): string[] {
    try {
      const parsed = JSON.parse(market.matched_asset_ids);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }
}

