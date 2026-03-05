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

      const correlationLogic = asset.correlation_logic;

      const instruments = this.instrumentRegistry
        ? this.instrumentRegistry.getBestInstruments(asset.avanza_search.underlying_terms[0])
        : { bull: [], bear: [] };

      const bullInstruments: MappedInstrument[] = instruments.bull.length > 0
        ? instruments.bull.map(inst => ({
            name: inst.name,
            avanza_id: inst.avanza_id,
            leverage: inst.leverage,
            avanza_url: inst.instrument_url,
            issuer: inst.issuer
          }))
        : [this.ontologyFallback(asset.name, 'bull')];

      const bearInstruments: MappedInstrument[] = instruments.bear.length > 0
        ? instruments.bear.map(inst => ({
            name: inst.name,
            avanza_id: inst.avanza_id,
            leverage: inst.leverage,
            avanza_url: inst.instrument_url,
            issuer: inst.issuer
          }))
        : [this.ontologyFallback(asset.name, 'bear')];

      mappings.push({
        assetId: asset.id,
        assetName: asset.name,
        polarity: correlationLogic.default_polarity,
        explanation: correlationLogic.explanation,
        instruments: {
          bull: bullInstruments,
          bear: bearInstruments
        }
      });
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
  private ontologyFallback(assetName: string, direction: 'bull' | 'bear'): MappedInstrument {
    return {
      name: `${direction.toUpperCase()} ${assetName}`,
      avanza_id: '',
      leverage: null,
      avanza_url: '',
      issuer: null
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
   * the market title/description. Used by the verification guard.
   */
  getMatchedKeywordsForAsset(market: TrackedMarket, assetId: string): string[] {
    const asset = this.ontology.getAsset(assetId);
    if (!asset) return [];

    const haystack = `${market.title} ${market.description || ''}`.toLowerCase();
    return asset.polymarket_patterns.keywords.filter(keyword =>
      haystack.includes(keyword.toLowerCase())
    );
  }
}
