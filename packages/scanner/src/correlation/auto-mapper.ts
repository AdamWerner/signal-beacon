import { OntologyEngine } from './ontology.js';
import { InstrumentRegistry } from '../avanza/instrument-registry.js';
import { TrackedMarket } from '../storage/market-store.js';

export interface MappedInstrument {
  name: string;
  avanza_id: string;
  leverage: number | null;
  avanza_url: string;
  issuer: string | null;
}

export interface CorrelationMapping {
  assetId: string;
  assetName: string;
  polarity: 'direct' | 'inverse' | 'context_dependent';
  explanation: string;
  instruments: {
    bull: MappedInstrument[];
    bear: MappedInstrument[];
  };
}

export class AutoMapper {
  constructor(
    private ontology: OntologyEngine,
    private instrumentRegistry: InstrumentRegistry | null
  ) {}

  /**
   * Build a mapping directly from an ontology asset.
   * Used by non-Polymarket signal origins that already resolved the asset.
   */
  getMappingForAsset(assetId: string): CorrelationMapping | null {
    const asset = this.ontology.getAsset(assetId);
    if (!asset) {
      return null;
    }

    const instruments = this.getBestInstrumentsForTerms(
      asset.avanza_search.underlying_terms || []
    );

    const bullInstruments: MappedInstrument[] = instruments.bull.length > 0
      ? instruments.bull.map(inst => ({
          name: inst.name,
          avanza_id: inst.avanza_id,
          leverage: inst.leverage,
          avanza_url: inst.instrument_url,
          issuer: inst.issuer
        }))
      : [this.ontologyFallback(asset.name, 'bull', asset.avanza_search.underlying_terms[0])];

    const bearInstruments: MappedInstrument[] = instruments.bear.length > 0
      ? instruments.bear.map(inst => ({
          name: inst.name,
          avanza_id: inst.avanza_id,
          leverage: inst.leverage,
          avanza_url: inst.instrument_url,
          issuer: inst.issuer
        }))
      : [this.ontologyFallback(asset.name, 'bear', asset.avanza_search.underlying_terms[0])];

    return {
      assetId: asset.id,
      assetName: asset.name,
      polarity: asset.correlation_logic.default_polarity,
      explanation: asset.correlation_logic.explanation,
      instruments: {
        bull: bullInstruments,
        bear: bearInstruments
      }
    };
  }

  /**
   * Map a tracked market to trading instruments
   */
  mapMarketToInstruments(market: TrackedMarket): CorrelationMapping[] {
    const mappings: CorrelationMapping[] = [];

    // Parse matched asset IDs from JSON
    let assetIds: string[];
    try {
      assetIds = JSON.parse(market.matched_asset_ids);
    } catch (error) {
      console.error('Failed to parse matched_asset_ids:', error);
      return [];
    }

    // For each matched asset, find instruments
    for (const assetId of assetIds) {
      const asset = this.ontology.getAsset(assetId);
      if (!asset) {
        console.warn(`Asset ${assetId} not found in ontology`);
        continue;
      }
      const strictKeywordMatch = this.getMatchedKeywordsForAsset(market, assetId);
      if (strictKeywordMatch.length === 0) {
        // Guard against stale tracked_markets rows that were matched under older, looser rules.
        // Sacred rule: title/description must include explicit ontology keywords for this asset.
        continue;
      }

      const mapping = this.getMappingForAsset(assetId);
      if (mapping) {
        mappings.push(mapping);
      }
    }

    return mappings;
  }

  /**
   * Determine trading direction based on polarity and odds change.
   * Returns null for context_dependent (requires human judgment).
   */
  determineTradingDirection(
    polarity: 'direct' | 'inverse' | 'context_dependent',
    oddsIncreasing: boolean
  ): 'bull' | 'bear' | null {
    if (polarity === 'context_dependent') {
      return null;
    }
    if (polarity === 'direct') {
      return oddsIncreasing ? 'bull' : 'bear';
    } else {
      return oddsIncreasing ? 'bear' : 'bull';
    }
  }

  /**
   * Fallback instrument suggestion from ontology asset name when no real
   * instruments have been discovered (Avanza not connected).
   */
  private ontologyFallback(
    assetName: string,
    direction: 'bull' | 'bear',
    preferredSearchTerm?: string
  ): MappedInstrument {
    const dir = direction.toUpperCase();
    const shortName = assetName
      .replace(/\s+(Technology|Holdings|Integrated|Services|Systems|Group)\b/gi, '')
      .trim();
    const baseSearchTerm = (preferredSearchTerm || shortName).trim();
    const avanzaQuery = `${baseSearchTerm} certifikat`;

    return {
      name: `${dir} ${shortName} X3 AVA`,
      avanza_id: '',
      leverage: 3,
      avanza_url: `https://www.avanza.se/sok.html?query=${encodeURIComponent(avanzaQuery)}`,
      issuer: null
    };
  }

  private getBestInstrumentsForTerms(terms: string[]): { bull: any[]; bear: any[] } {
    if (!this.instrumentRegistry) {
      return { bull: [], bear: [] };
    }

    const bull = new Map<string, any>();
    const bear = new Map<string, any>();

    for (const term of terms) {
      const trimmed = String(term || '').trim();
      if (!trimmed) continue;
      const candidates = this.instrumentRegistry.getBestInstruments(trimmed);

      for (const instrument of candidates.bull) {
        if (!bull.has(instrument.avanza_id)) {
          bull.set(instrument.avanza_id, instrument);
        }
      }
      for (const instrument of candidates.bear) {
        if (!bear.has(instrument.avanza_id)) {
          bear.set(instrument.avanza_id, instrument);
        }
      }
    }

    const sortByLeverage = (items: any[]) =>
      items.sort((a, b) => {
        const leverageA = a.leverage ?? Number.MAX_SAFE_INTEGER;
        const leverageB = b.leverage ?? Number.MAX_SAFE_INTEGER;
        return leverageA - leverageB;
      }).slice(0, 3);

    return {
      bull: sortByLeverage(Array.from(bull.values())),
      bear: sortByLeverage(Array.from(bear.values()))
    };
  }

  /**
   * Get suggested instruments for a signal
   */
  getSuggestedInstruments(
    mapping: CorrelationMapping,
    direction: 'bull' | 'bear'
  ): MappedInstrument[] {
    return direction === 'bull' ? mapping.instruments.bull : mapping.instruments.bear;
  }

  /**
   * Return the ontology keywords for a specific asset that explicitly appear in
   * the market title. Used by the verification guard.
   * Sacred rule: title keyword evidence only.
   */
  getMatchedKeywordsForAsset(market: TrackedMarket, assetId: string): string[] {
    const asset = this.ontology.getAsset(assetId);
    if (!asset) return [];

    const haystack = String(market.title || '').toLowerCase();
    return asset.polymarket_patterns.keywords.filter(keyword =>
      haystack.includes(keyword.toLowerCase())
    );
  }
}
