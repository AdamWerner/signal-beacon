import { MarketDiscoverer } from '../polymarket/market-discoverer.js';

export class MarketRefreshJob {
  constructor(private marketDiscoverer: MarketDiscoverer) {}

  /**
   * Refresh the tracked markets registry
   */
  async execute() {
    console.log('\n=== MARKET REFRESH START ===');
    console.log(new Date().toISOString());

    try {
      const result = await this.marketDiscoverer.discoverMarkets();

      console.log('\n=== MARKET REFRESH COMPLETE ===');
      console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);

      return result;
    } catch (error) {
      console.error('Market refresh failed:', error);
      throw error;
    }
  }
}
