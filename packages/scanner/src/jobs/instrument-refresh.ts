import { AvanzaScraper } from '../avanza/scraper.js';

export class InstrumentRefreshJob {
  constructor(private scraper: AvanzaScraper) {}

  /**
   * Refresh the Avanza instruments registry
   */
  async execute() {
    console.log('\n=== INSTRUMENT REFRESH START ===');
    console.log(new Date().toISOString());

    try {
      const result = await this.scraper.refreshAll();

      console.log('\n=== INSTRUMENT REFRESH COMPLETE ===');
      console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);

      return result;
    } catch (error) {
      console.error('Instrument refresh failed:', error);
      throw error;
    }
  }
}
