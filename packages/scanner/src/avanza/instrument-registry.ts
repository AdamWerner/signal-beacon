import { InstrumentStore, InsertInstrument } from '../storage/instrument-store.js';
import { AvanzaSearchClient } from './search-client.js';
import { parseCertificateName, generateInstrumentUrl } from './certificate-parser.js';
import { AvanzaInstrument } from './types.js';

export interface InstrumentRegistryStats {
  total_active: number;
  total_discovered: number;
  newly_added: number;
  marked_inactive: number;
  by_underlying: Record<string, { bull: number; bear: number }>;
}

export class InstrumentRegistry {
  constructor(
    private store: InstrumentStore,
    private searchClient: AvanzaSearchClient
  ) {}

  /**
   * Discover and register certificates for a specific underlying asset
   */
  async discoverForUnderlying(
    underlyingTerms: string[],
    preferredIssuers: string[] = [],
    preferredLeverage: number[] = []
  ): Promise<number> {
    console.log(`Discovering certificates for: ${underlyingTerms.join(', ')}`);

    const instruments = await this.searchClient.searchUnderlyingAsset(underlyingTerms);

    let newCount = 0;

    for (const instrument of instruments) {
      const parsed = parseCertificateName(instrument.id, instrument.name);

      if (!parsed) {
        console.log(`  ⚠ Could not parse: ${instrument.name}`);
        continue;
      }

      const instrumentData: InsertInstrument = {
        id: `${parsed.direction}_${parsed.underlying}_${instrument.id}`,
        avanza_id: instrument.id,
        name: instrument.name,
        direction: parsed.direction,
        underlying: parsed.underlying,
        leverage: parsed.leverage,
        issuer: parsed.issuer,
        instrument_url: generateInstrumentUrl(instrument.id, instrument.name)
      };

      const existing = this.store.findByAvanzaId(instrument.id);
      if (!existing) {
        newCount++;
        console.log(`  ✓ New: ${instrument.name} (${instrument.id})`);
      }

      this.store.insert(instrumentData);
    }

    return newCount;
  }

  /**
   * Get the best instruments for an underlying asset
   */
  getBestInstruments(
    underlying: string,
    preferredIssuers: string[] = [],
    preferredLeverage: number[] = []
  ): {
    bull: InsertInstrument[];
    bear: InsertInstrument[];
  } {
    const bulls = this.store.findByUnderlying(underlying, 'bull');
    const bears = this.store.findByUnderlying(underlying, 'bear');

    // Scoring function for ranking instruments
    const scoreInstrument = (inst: any): number => {
      let score = 0;

      // Preferred issuer: +10 points
      if (inst.issuer && preferredIssuers.includes(inst.issuer)) {
        score += 10;
      }

      // Preferred leverage: +5 points
      if (inst.leverage && preferredLeverage.includes(inst.leverage)) {
        score += 5;
      }

      // Lower leverage is generally safer (tie-breaker)
      if (inst.leverage) {
        score += 10 / inst.leverage;
      }

      return score;
    };

    const sortedBulls = bulls
      .map(inst => ({ ...inst, score: scoreInstrument(inst) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const sortedBears = bears
      .map(inst => ({ ...inst, score: scoreInstrument(inst) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return {
      bull: sortedBulls,
      bear: sortedBears
    };
  }

  /**
   * Mark instruments as inactive if they haven't been seen in X days
   */
  markStaleInstruments(daysSinceVerification = 7): number {
    return this.store.markStaleAsInactive(daysSinceVerification);
  }

  /**
   * Get registry statistics
   */
  getStats(): InstrumentRegistryStats {
    const all = this.store.findAll(false);
    const active = this.store.findAll(true);
    const byUnderlying = this.store.countByUnderlying();

    return {
      total_active: active.length,
      total_discovered: all.length,
      newly_added: 0, // Set during refresh
      marked_inactive: all.length - active.length,
      by_underlying: byUnderlying
    };
  }
}
