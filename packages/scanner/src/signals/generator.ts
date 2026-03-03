import { OddsChange } from '../polymarket/odds-tracker.js';
import { AutoMapper, CorrelationMapping } from '../correlation/auto-mapper.js';
import { MarketStore } from '../storage/market-store.js';
import { WhaleDetector } from '../polymarket/whale-detector.js';
import { SignalStore } from '../storage/signal-store.js';
import { calculateConfidence } from './scorer.js';
import { GeneratedSignal } from './types.js';

const DEDUP_WINDOW_HOURS = 4;
const DEDUP_ESCALATION_THRESHOLD_PCT = 5;
const CONTEXT_DEPENDENT_MAX_CONFIDENCE = 60;

export class SignalGenerator {
  constructor(
    private autoMapper: AutoMapper,
    private marketStore: MarketStore,
    private whaleDetector: WhaleDetector,
    private signalStore: SignalStore
  ) {}

  /**
   * Generate signals from detected odds changes.
   * Creates one signal per matched asset. For context_dependent polarity,
   * creates both a BULL and BEAR variant flagged with requires_judgment.
   */
  async generateSignals(oddsChanges: OddsChange[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];

    console.log(`Generating signals for ${oddsChanges.length} odds changes...`);

    for (const change of oddsChanges) {
      const market = this.marketStore.findByConditionId(change.market_condition_id);
      if (!market) {
        continue;
      }

      const mappings = this.autoMapper.mapMarketToInstruments(market);

      if (mappings.length === 0) {
        console.log(`  ⚠ No instruments found for market: ${market.title}`);
        continue;
      }

      const whaleActivity = this.whaleDetector.getRecentWhaleActivity(
        market.condition_id,
        change.time_window_minutes
      );
      const whaleDetected = whaleActivity.length > 0;
      const whaleAmountUsd = whaleDetected
        ? whaleActivity.reduce((sum, w) => sum + w.size_usd, 0)
        : null;

      // Generate a signal for each matched asset
      for (const mapping of mappings) {
        const newSignals = this.createSignalsForMapping(
          change,
          market,
          mapping,
          whaleDetected,
          whaleAmountUsd
        );

        for (const signal of newSignals) {
          // Deduplication check
          const existing = this.signalStore.findRecentByDeduplicationKey(
            signal.deduplication_key,
            DEDUP_WINDOW_HOURS
          );

          if (existing) {
            const deltaIncreased = Math.abs(signal.delta_pct) - Math.abs(existing.delta_pct);
            if (deltaIncreased < DEDUP_ESCALATION_THRESHOLD_PCT) {
              console.log(`  ⟳ Skipping duplicate signal for ${mapping.assetName} (key: ${signal.deduplication_key})`);
              continue;
            }
            console.log(`  ↑ Escalation detected (+${deltaIncreased.toFixed(1)}%) for ${mapping.assetName}`);
          }

          signals.push(signal);
          this.signalStore.insert(signal);
          console.log(`  ✓ Signal: ${signal.suggested_action} for ${mapping.assetName} (confidence: ${signal.confidence}%${signal.requires_judgment ? ', ⚖ judgment required' : ''})`);
        }
      }
    }

    return signals;
  }

  /**
   * Create signals for a single mapping.
   * Returns two signals (BULL + BEAR) for context_dependent polarity, one otherwise.
   */
  private createSignalsForMapping(
    change: OddsChange,
    market: any,
    mapping: CorrelationMapping,
    whaleDetected: boolean,
    whaleAmountUsd: number | null
  ): GeneratedSignal[] {
    if (mapping.polarity === 'context_dependent') {
      return [
        this.createSignal(change, market, mapping, whaleDetected, whaleAmountUsd, 'bull'),
        this.createSignal(change, market, mapping, whaleDetected, whaleAmountUsd, 'bear'),
      ];
    }

    const oddsIncreasing = change.delta_pct > 0;
    const direction = this.autoMapper.determineTradingDirection(mapping.polarity, oddsIncreasing) as 'bull' | 'bear';
    return [this.createSignal(change, market, mapping, whaleDetected, whaleAmountUsd, direction)];
  }

  private createSignal(
    change: OddsChange,
    market: any,
    mapping: CorrelationMapping,
    whaleDetected: boolean,
    whaleAmountUsd: number | null,
    direction: 'bull' | 'bear'
  ): GeneratedSignal {
    const instruments = this.autoMapper.getSuggestedInstruments(mapping, direction);

    let confidence = calculateConfidence({
      delta_pct: change.delta_pct,
      time_window_minutes: change.time_window_minutes,
      whale_detected: whaleDetected,
      whale_usd: whaleAmountUsd || undefined,
      volume: market.volume,
      relevance_score: market.relevance_score
    });

    const requiresJudgment = mapping.polarity === 'context_dependent';
    if (requiresJudgment) {
      confidence = Math.min(confidence, CONTEXT_DEPENDENT_MAX_CONFIDENCE);
    }

    const reasoning = this.generateReasoning(change, mapping, direction, whaleDetected, whaleAmountUsd, requiresJudgment);

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const id = `sig_${timestamp}_${Math.random().toString(36).substring(2, 8)}`;
    const deduplication_key = `${market.condition_id}_${mapping.assetId}_${direction}`;

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
      confidence,
      requires_judgment: requiresJudgment,
      deduplication_key
    };
  }

  private generateReasoning(
    change: OddsChange,
    mapping: CorrelationMapping,
    direction: 'bull' | 'bear',
    whaleDetected: boolean,
    whaleAmountUsd: number | null,
    requiresJudgment: boolean
  ): string {
    const parts: string[] = [];

    const deltaDir = change.delta_pct > 0 ? 'surged' : 'dropped';
    parts.push(
      `Polymarket odds ${deltaDir} ${Math.abs(change.delta_pct).toFixed(1)}% in ${change.time_window_minutes}min`
    );

    if (whaleDetected && whaleAmountUsd) {
      parts.push(`(whale: $${(whaleAmountUsd / 1000).toFixed(0)}K)`);
    }

    parts.push(mapping.explanation);

    if (requiresJudgment) {
      parts.push(`⚖ Context-dependent: human judgment required before acting.`);
    }

    return parts.join('. ');
  }
}
