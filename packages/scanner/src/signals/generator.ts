import { OddsChange } from '../polymarket/odds-tracker.js';
import { AutoMapper, CorrelationMapping } from '../correlation/auto-mapper.js';
import { MarketStore } from '../storage/market-store.js';
import { WhaleDetector } from '../polymarket/whale-detector.js';
import { SignalStore } from '../storage/signal-store.js';
import { calculateConfidence } from './scorer.js';
import { GeneratedSignal } from './types.js';

export class SignalGenerator {
  constructor(
    private autoMapper: AutoMapper,
    private marketStore: MarketStore,
    private whaleDetector: WhaleDetector,
    private signalStore: SignalStore
  ) {}

  /**
   * Generate signals from detected odds changes
   */
  async generateSignals(oddsChanges: OddsChange[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];

    console.log(`Generating signals for ${oddsChanges.length} odds changes...`);

    for (const change of oddsChanges) {
      const market = this.marketStore.findByConditionId(change.market_condition_id);
      if (!market) {
        continue;
      }

      // Get correlation mappings
      const mappings = this.autoMapper.mapMarketToInstruments(market);

      if (mappings.length === 0) {
        console.log(`  ⚠ No instruments found for market: ${market.title}`);
        continue;
      }

      // Check for whale activity
      const whaleActivity = this.whaleDetector.getRecentWhaleActivity(
        market.condition_id,
        change.time_window_minutes
      );

      const whaleDetected = whaleActivity.length > 0;
      const whaleAmountUsd = whaleDetected
        ? whaleActivity.reduce((sum, w) => sum + w.size_usd, 0)
        : null;

      // Generate a signal for the primary mapping (highest score)
      const primaryMapping = mappings[0];

      const signal = this.createSignal(
        change,
        market,
        primaryMapping,
        whaleDetected,
        whaleAmountUsd
      );

      signals.push(signal);

      // Store in database
      this.signalStore.insert(signal);

      console.log(`  ✓ Signal generated: ${signal.suggested_action} (confidence: ${signal.confidence}%)`);
    }

    return signals;
  }

  /**
   * Create a signal from odds change and mapping
   */
  private createSignal(
    change: OddsChange,
    market: any,
    mapping: CorrelationMapping,
    whaleDetected: boolean,
    whaleAmountUsd: number | null
  ): GeneratedSignal {
    // Determine trading direction
    const oddsIncreasing = change.delta_pct > 0;
    const direction = this.autoMapper.determineTradingDirection(
      mapping.polarity,
      oddsIncreasing
    );

    // Get suggested instruments
    const instruments = this.autoMapper.getSuggestedInstruments(mapping, direction);

    // Calculate confidence
    const confidence = calculateConfidence({
      delta_pct: change.delta_pct,
      time_window_minutes: change.time_window_minutes,
      whale_detected: whaleDetected,
      whale_usd: whaleAmountUsd || undefined,
      volume: market.volume,
      relevance_score: market.relevance_score
    });

    // Generate reasoning
    const reasoning = this.generateReasoning(
      change,
      mapping,
      direction,
      whaleDetected,
      whaleAmountUsd
    );

    // Generate unique ID
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const id = `sig_${timestamp}_${Math.random().toString(36).substring(2, 8)}`;

    return {
      id,
      market_condition_id: market.condition_id,
      market_slug: market.slug,
      market_title: market.title,
      odds_before: change.odds_before,
      odds_now: change.odds_now,
      delta_pct: change.delta_pct,
      time_window_minutes: change.time_window_minutes,
      whale_detected: whaleDetected,
      whale_amount_usd: whaleAmountUsd,
      matched_asset_id: mapping.assetId,
      matched_asset_name: mapping.assetName,
      polarity: mapping.polarity,
      suggested_action: `Consider ${direction.toUpperCase()} position`,
      suggested_instruments: instruments,
      reasoning,
      confidence
    };
  }

  /**
   * Generate human-readable reasoning for the signal
   */
  private generateReasoning(
    change: OddsChange,
    mapping: CorrelationMapping,
    direction: 'bull' | 'bear',
    whaleDetected: boolean,
    whaleAmountUsd: number | null
  ): string {
    const parts: string[] = [];

    // Odds change
    const deltaDir = change.delta_pct > 0 ? 'surged' : 'dropped';
    parts.push(
      `Polymarket odds ${deltaDir} ${Math.abs(change.delta_pct).toFixed(1)}% in ${change.time_window_minutes}min`
    );

    // Whale activity
    if (whaleDetected && whaleAmountUsd) {
      parts.push(`(whale: $${(whaleAmountUsd / 1000).toFixed(0)}K)`);
    }

    // Correlation explanation
    parts.push(mapping.explanation);

    return parts.join('. ');
  }
}
