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
  polarity: 'direct' | 'inverse';
  explanation: string;
  instruments: {
    bull: MappedInstrument[];
    bear: MappedInstrument[];
  };
}

export class AutoMapper {
  constructor(
    private ontology: OntologyEngine,
    private instrumentRegistry: InstrumentRegistry
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

      // Get correlation logic
      const correlationLogic = asset.correlation_logic;

      // Find best instruments for this underlying
      const instruments = this.instrumentRegistry.getBestInstruments(
        asset.avanza_search.underlying_terms[0], // Use primary term
        asset.avanza_search.preferred_issuers,
        asset.avanza_search.preferred_leverage
      );

      // Map to MappedInstrument format
      const bullInstruments: MappedInstrument[] = instruments.bull.map(inst => ({
        name: inst.name,
        avanza_id: inst.avanza_id,
        leverage: inst.leverage,
        avanza_url: inst.instrument_url,
        issuer: inst.issuer
      }));

      const bearInstruments: MappedInstrument[] = instruments.bear.map(inst => ({
        name: inst.name,
        avanza_id: inst.avanza_id,
        leverage: inst.leverage,
        avanza_url: inst.instrument_url,
        issuer: inst.issuer
      }));

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
   * Determine trading direction based on polarity and odds change
   */
  determineTradingDirection(
    polarity: 'direct' | 'inverse',
    oddsIncreasing: boolean
  ): 'bull' | 'bear' {
    if (polarity === 'direct') {
      return oddsIncreasing ? 'bull' : 'bear';
    } else {
      return oddsIncreasing ? 'bear' : 'bull';
    }
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
}
