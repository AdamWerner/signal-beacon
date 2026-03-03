import { InstrumentRegistry, InstrumentRegistryStats } from './instrument-registry.js';
import { OntologyEngine, OntologyAsset } from '../correlation/ontology.js';

export interface ScraperResult {
  assetsProcessed: number;
  instrumentsDiscovered: number;
  instrumentsMarkedInactive: number;
  stats: InstrumentRegistryStats;
  duration: number;
}

export class AvanzaScraper {
  constructor(
    private registry: InstrumentRegistry,
    private ontology: OntologyEngine
  ) {}

  /**
   * Run a full refresh of all instruments from the ontology
   */
  async refreshAll(): Promise<ScraperResult> {
    const startTime = Date.now();
    console.log('Starting Avanza instrument refresh...');

    const assets = this.ontology.getAllAssets();
    let totalDiscovered = 0;

    for (const asset of assets) {
      console.log(`\nProcessing asset: ${asset.name} (${asset.id})`);

      const discovered = await this.registry.discoverForUnderlying(
        asset.avanza_search.underlying_terms
      );

      totalDiscovered += discovered;
      console.log(`  Found ${discovered} new certificates`);
    }

    // Mark stale instruments as inactive (not seen in 7 days)
    console.log('\nMarking stale instruments as inactive...');
    const markedInactive = this.registry.markStaleInstruments(7);
    console.log(`  Marked ${markedInactive} instruments as inactive`);

    const stats = this.registry.getStats();
    const duration = Date.now() - startTime;

    console.log(`\n✓ Refresh complete in ${(duration / 1000).toFixed(1)}s`);
    console.log(`  Total active: ${stats.total_active}`);
    console.log(`  Newly discovered: ${totalDiscovered}`);
    console.log(`  Marked inactive: ${markedInactive}`);

    return {
      assetsProcessed: assets.length,
      instrumentsDiscovered: totalDiscovered,
      instrumentsMarkedInactive: markedInactive,
      stats,
      duration
    };
  }

  /**
   * Refresh instruments for a single asset
   */
  async refreshAsset(assetId: string): Promise<number> {
    const asset = this.ontology.getAsset(assetId);
    if (!asset) {
      throw new Error(`Asset not found: ${assetId}`);
    }

    console.log(`Refreshing instruments for: ${asset.name}`);

    return await this.registry.discoverForUnderlying(
      asset.avanza_search.underlying_terms
    );
  }
}
