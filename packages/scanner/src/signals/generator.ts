import { OddsChange } from '../polymarket/odds-tracker.js';
import { AutoMapper, CorrelationMapping } from '../correlation/auto-mapper.js';
import { MarketStore } from '../storage/market-store.js';
import { WhaleDetector } from '../polymarket/whale-detector.js';
import { SignalStore } from '../storage/signal-store.js';
import { SnapshotStore } from '../storage/snapshot-store.js';
import { calculateConfidence } from './scorer.js';
import { analyzeMomentum } from './momentum.js';
import { GeneratedSignal } from './types.js';
import { BatchVerificationCandidate, TradeVerificationGate } from '../verification/trade-gate.js';
import { VerificationContext } from '../verification/types.js';
import { isNoiseMarketQuestion } from '../polymarket/noise-filter.js';

const DEDUP_WINDOW_HOURS = 4;
const DEDUP_ESCALATION_THRESHOLD_PCT = 5;
const CONTEXT_DEPENDENT_MAX_CONFIDENCE = 40;

export class SignalGenerator {
  constructor(
    private autoMapper: AutoMapper,
    private marketStore: MarketStore,
    private whaleDetector: WhaleDetector,
    private signalStore: SignalStore,
    private verificationGate: TradeVerificationGate,
    private snapshotStore: SnapshotStore
  ) {}

  /**
   * Generate signals from detected odds changes.
   * Creates one signal per matched asset. Context-dependent signals are capped
   * and always require judgment.
   */
  async generateSignals(oddsChanges: OddsChange[]): Promise<GeneratedSignal[]> {
    const signals: GeneratedSignal[] = [];
    const recentSignals = this.signalStore.findFiltered({ hours: 48, limit: 500 });
    const batchCandidates: BatchVerificationCandidate[] = [];
    let dedupSkipped = 0;
    let noInstrumentSkipped = 0;
    let lowConfidenceSkipped = 0;
    let cycleEscalationSkipped = 0;
    const cycleAbsDeltaByKey = new Map<string, number>();
    const minStoreConfidence = Math.max(0, parseInt(process.env.SIGNAL_MIN_CONFIDENCE_STORE || '12', 10));
    const minStoreConfidenceMicro = Math.max(
      minStoreConfidence,
      parseInt(process.env.SIGNAL_MIN_CONFIDENCE_MICRO || '25', 10)
    );
    const minCycleEscalationDelta = Math.max(
      DEDUP_ESCALATION_THRESHOLD_PCT,
      parseFloat(process.env.SIGNAL_CYCLE_ESCALATION_MIN_DELTA_PCT || '15')
    );

    console.log(`Generating signals for ${oddsChanges.length} odds changes...`);

    for (const change of oddsChanges) {
      const market = this.marketStore.findByConditionId(change.market_condition_id);
      if (!market) continue;
      if (isNoiseMarketQuestion(market.title)) {
        continue;
      }

      const mappings = this.autoMapper.mapMarketToInstruments(market);
      if (mappings.length === 0) {
        noInstrumentSkipped += 1;
        if (noInstrumentSkipped <= 12) {
          console.log(`  [skip] no instruments for market: ${market.title}`);
        }
        continue;
      }

      const whaleActivity = this.whaleDetector.getRecentWhaleActivity(
        market.condition_id,
        change.time_window_minutes
      );
      const whaleDetected = whaleActivity.length > 0;
      const whaleAmountUsd = whaleDetected
        ? whaleActivity.reduce((sum, whale) => sum + whale.size_usd, 0)
        : null;

      // Momentum analysis — fetch last 2h of snapshots once per market
      const marketSnapshots = this.snapshotStore.getHistory(market.condition_id, 2);
      const momentumDirection = change.delta_pct > 0 ? 'up' : 'down';
      const momentum = analyzeMomentum(
        marketSnapshots.slice(0, 8).map(s => ({ odds_yes: s.odds_yes, timestamp: s.timestamp })),
        momentumDirection
      );

      for (const mapping of mappings) {
        const keywordEvidence = this.autoMapper.getMatchedKeywordsForAsset(market, mapping.assetId);

        const newSignals = this.createSignalsForMapping(
          change,
          market,
          mapping,
          whaleDetected,
          whaleAmountUsd
        );

        for (const signal of newSignals) {
          const baseConfidence = signal.confidence;
          const isMicroTimebox = this.isMicroTimeboxMarket(market.title);

          // Apply momentum boost before dedup and verification
          signal.confidence = Math.max(0, Math.min(signal.confidence + momentum.boost, 92));
          // Re-enforce context_dependent cap after momentum adjustment
          if (signal.requires_judgment) {
            signal.confidence = Math.min(signal.confidence, CONTEXT_DEPENDENT_MAX_CONFIDENCE);
          }

          if (isMicroTimebox) {
            signal.confidence = Math.max(0, signal.confidence - 28);
            signal.reasoning += ' [micro_timebox:-28]';
          }

          const instability = this.getDirectionalInstabilityPenalty(recentSignals, signal);
          if (instability.penalty > 0) {
            signal.confidence = Math.max(0, signal.confidence - instability.penalty);
            signal.reasoning +=
              ` [instability:-${instability.penalty} same:${instability.sameDirection}` +
              ` opp:${instability.oppositeDirection}]`;
          }

          // Append momentum trend to reasoning
          if (momentum.trend !== 'insufficient_data') {
            signal.reasoning += ` Momentum: ${momentum.trend} (${momentum.cyclesInDirection} cycles).`;
          }

          const existing = this.signalStore.findRecentByDeduplicationKey(
            signal.deduplication_key,
            DEDUP_WINDOW_HOURS
          );

          if (existing) {
            const deltaIncreased = Math.abs(signal.delta_pct) - Math.abs(existing.delta_pct);
            if (!Number.isFinite(deltaIncreased) || deltaIncreased < DEDUP_ESCALATION_THRESHOLD_PCT) {
              dedupSkipped += 1;
              if (dedupSkipped <= 12) {
                console.log(
                  `  [dedup] skipping duplicate signal for ${mapping.assetName} (${signal.deduplication_key})`
                );
              }
              continue;
            }

            const cycleAbsDelta = cycleAbsDeltaByKey.get(signal.deduplication_key);
            if (typeof cycleAbsDelta === 'number') {
              const cycleEscalationGain = Math.abs(signal.delta_pct) - cycleAbsDelta;
              if (!Number.isFinite(cycleEscalationGain) || cycleEscalationGain < minCycleEscalationDelta) {
                cycleEscalationSkipped += 1;
                if (cycleEscalationSkipped <= 12) {
                  console.log(
                    `  [dedup] skipping same-cycle escalation for ${mapping.assetName} ` +
                    `(+${cycleEscalationGain.toFixed(1)}%, need +${minCycleEscalationDelta.toFixed(1)}%)`
                  );
                }
                continue;
              }
            }

            console.log(
              `  [dedup] escalation +${deltaIncreased.toFixed(1)}% for ${mapping.assetName}`
            );
          }

          // Max 3 signals per asset per cycle to prevent clustering
          const assetCountThisCycle = signals.filter(s => s.matched_asset_id === signal.matched_asset_id).length;
          if (assetCountThisCycle >= 3) {
            continue; // silent skip — not worth logging every one
          }

          const verificationContext: VerificationContext = {
            marketTitle: signal.market_title,
            marketDescription: market.description || null,
            marketCategory: market.category || null,
            matchedAssetId: signal.matched_asset_id,
            matchedAssetName: signal.matched_asset_name,
            polarity: signal.polarity,
            suggestedAction: signal.suggested_action,
            oddsBefore: signal.odds_before,
            oddsNow: signal.odds_now,
            deltaPct: signal.delta_pct,
            timeframeMinutes: signal.time_window_minutes,
            whaleDetected: signal.whale_detected,
            whaleAmountUsd: signal.whale_amount_usd,
            ontologyKeywords: keywordEvidence,
            reinforcingSignals: this.getReinforcingSignals(recentSignals, signal),
            conflictingSignals: this.getConflictingSignals(recentSignals, signal)
          };
          const verification = this.verificationGate.guardOnly(verificationContext);
          const guardFromRecord = (verification.record as any)?.guard;

          signal.verification_status = verification.status;
          signal.verification_score = verification.score;
          signal.verification_reason = verification.reason;
          signal.verification_flags = verification.flags;
          signal.verification_source = verification.source;
          signal.verification_record = JSON.stringify(verification.record);
          signal.confidence = Math.max(
            0,
            Math.min(signal.confidence + verification.confidenceAdjustment, 92)
          );

          if (verification.suggestedActionOverride) {
            signal.suggested_action = verification.suggestedActionOverride;
          }

          if (
            guardFromRecord &&
            (guardFromRecord.status === 'approved' || guardFromRecord.status === 'needs_review')
          ) {
            batchCandidates.push({
              signalId: signal.id,
              confidence: signal.confidence,
              context: verificationContext,
              guard: guardFromRecord
            });
          }

          // Confidence breakdown tag for transparency in push notifications + detail page
          const breakdown: string[] = [`base:${baseConfidence}`];
          if (momentum.boost !== 0) breakdown.push(`mom:${momentum.boost > 0 ? '+' : ''}${momentum.boost}`);
          if (isMicroTimebox) breakdown.push('micro:-28');
          if (instability.penalty > 0) breakdown.push(`instability:-${instability.penalty}`);
          if (verification.confidenceAdjustment !== 0) breakdown.push(`verify:${verification.confidenceAdjustment > 0 ? '+' : ''}${verification.confidenceAdjustment}`);
          signal.reasoning += ` [score: ${breakdown.join(', ')}]`;

          const minConfidenceForStorage = isMicroTimebox ? minStoreConfidenceMicro : minStoreConfidence;
          if (signal.confidence < minConfidenceForStorage) {
            lowConfidenceSkipped += 1;
            if (lowConfidenceSkipped <= 12) {
              console.log(
                `  [quality] skipping low-confidence signal for ${mapping.assetName} ` +
                `(${signal.confidence}% < ${minConfidenceForStorage}%)`
              );
            }
            continue;
          }

          signals.push(signal);
          this.signalStore.insert(signal);
          cycleAbsDeltaByKey.set(signal.deduplication_key, Math.abs(signal.delta_pct));

          recentSignals.unshift({
            ...signal,
            timestamp: new Date().toISOString(),
            suggested_instruments: JSON.stringify(signal.suggested_instruments),
            ai_analysis: null,
            status: 'new'
          } as any);

          console.log(
            `  [ok] ${signal.suggested_action} ${mapping.assetName} ` +
            `(confidence ${signal.confidence}%, verification ${signal.verification_status})`
          );
        }
      }
    }

    if (dedupSkipped > 12) {
      console.log(`  [dedup] skipped ${dedupSkipped - 12} additional duplicates (suppressed)`);
    }
    if (cycleEscalationSkipped > 12) {
      console.log(`  [dedup] skipped ${cycleEscalationSkipped - 12} same-cycle escalations (suppressed)`);
    }
    if (noInstrumentSkipped > 12) {
      console.log(`  [skip] no instruments for ${noInstrumentSkipped - 12} additional markets (suppressed)`);
    }
    if (lowConfidenceSkipped > 12) {
      console.log(`  [quality] skipped ${lowConfidenceSkipped - 12} low-confidence signals (suppressed)`);
    }

    if (batchCandidates.length > 0) {
      await this.applyBatchVerification(batchCandidates, signals);
    }

    return signals;
  }

  /**
   * Create signals for a single mapping.
   * Context-dependent mappings emit one judgment-required signal.
   */
  private createSignalsForMapping(
    change: OddsChange,
    market: any,
    mapping: CorrelationMapping,
    whaleDetected: boolean,
    whaleAmountUsd: number | null
  ): GeneratedSignal[] {
    if (mapping.polarity === 'context_dependent') {
      return [this.createSignal(change, market, mapping, whaleDetected, whaleAmountUsd, 'bull')];
    }

    const oddsIncreasing = change.delta_pct > 0;
    const direction = this.autoMapper.determineTradingDirection(
      mapping.polarity,
      oddsIncreasing
    ) as 'bull' | 'bear';

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
      relevance_score: market.relevance_score,
      abs_change_pp: change.odds_now - change.odds_before,
      odds_now: change.odds_now,
      odds_before: change.odds_before
    });

    const requiresJudgment = mapping.polarity === 'context_dependent';
    if (requiresJudgment) {
      confidence = Math.min(confidence, CONTEXT_DEPENDENT_MAX_CONFIDENCE);
    }

    const reasoning = this.generateReasoning(
      change,
      mapping,
      direction,
      whaleDetected,
      whaleAmountUsd,
      requiresJudgment
    );

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
      deduplication_key,
      verification_status: 'pending',
      verification_score: 0,
      verification_reason: 'Pending verification',
      verification_flags: [],
      verification_source: 'none',
      verification_record: null
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
    const deltaDir = change.delta_pct > 0 ? 'UP' : 'DOWN';
    const absChange = Math.abs(change.delta_pct).toFixed(0);
    const oddsNow = (change.odds_now * 100).toFixed(0);
    const oddsBefore = (change.odds_before * 100).toFixed(0);

    let reason =
      `Polymarket: "${mapping.explanation}" odds ${deltaDir} ${absChange}% ` +
      `(${oddsBefore}%->${oddsNow}%) in ${change.time_window_minutes}m.`;

    if (whaleDetected && whaleAmountUsd) {
      reason += ` Whale flow: $${(whaleAmountUsd / 1000).toFixed(0)}K.`;
    }

    reason += ` -> ${direction.toUpperCase()} ${mapping.assetName}.`;

    if (requiresJudgment) {
      reason += ' Context dependent, human validation required.';
    }

    return reason;
  }

  private getReinforcingSignals(recentSignals: Array<{ [key: string]: any }>, signal: GeneratedSignal) {
    const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';

    return recentSignals
      .filter(existing =>
        existing.matched_asset_id === signal.matched_asset_id &&
        String(existing.suggested_action || '').toLowerCase().includes(direction) &&
        existing.id !== signal.id
      )
      .slice(0, 6)
      .map(existing => ({
        id: String(existing.id),
        asset: String(existing.matched_asset_name || ''),
        confidence: Number(existing.confidence || 0),
        direction
      }));
  }

  private getConflictingSignals(recentSignals: Array<{ [key: string]: any }>, signal: GeneratedSignal) {
    const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
    const opposite = direction === 'bull' ? 'bear' : 'bull';

    return recentSignals
      .filter(existing =>
        existing.matched_asset_id === signal.matched_asset_id &&
        String(existing.suggested_action || '').toLowerCase().includes(opposite) &&
        existing.id !== signal.id
      )
      .slice(0, 6)
      .map(existing => ({
        id: String(existing.id),
        asset: String(existing.matched_asset_name || ''),
        confidence: Number(existing.confidence || 0),
        direction: opposite
      }));
  }

  private async applyBatchVerification(
    candidates: BatchVerificationCandidate[],
    generatedSignals: GeneratedSignal[]
  ): Promise<void> {
    const decisions = await this.verificationGate.batchVerifyTopCandidates(candidates, 5);
    if (decisions.size === 0) return;

    const byId = new Map(generatedSignals.map(signal => [signal.id, signal]));
    const sourceCounts = new Map<string, number>();
    const statusCounts = new Map<string, number>();

    for (const [signalId, decision] of decisions.entries()) {
      const signal = byId.get(signalId);
      if (!signal) continue;

      signal.verification_status = decision.status;
      signal.verification_score = decision.score;
      signal.verification_reason = decision.reason;
      signal.verification_flags = decision.flags;
      signal.verification_source = decision.source;
      signal.verification_record = JSON.stringify(decision.record || {});

      const before = signal.confidence;
      signal.confidence = Math.max(0, Math.min(signal.confidence + decision.confidenceAdjustment, 92));
      if (decision.status === 'rejected' && signal.confidence >= before) {
        signal.confidence = Math.max(0, signal.confidence - 10);
      }

      if (decision.suggestedActionOverride) {
        signal.suggested_action = decision.suggestedActionOverride;
      }

      this.signalStore.setVerification(signal.id, {
        status: signal.verification_status,
        score: signal.verification_score,
        reason: signal.verification_reason,
        flags: signal.verification_flags,
        source: signal.verification_source,
        record: signal.verification_record
      });
      this.signalStore.updateConfidence(signal.id, signal.confidence);
      if (decision.suggestedActionOverride) {
        this.signalStore.updateSuggestedAction(signal.id, signal.suggested_action);
      }

      sourceCounts.set(decision.source, (sourceCounts.get(decision.source) || 0) + 1);
      statusCounts.set(decision.status, (statusCounts.get(decision.status) || 0) + 1);
    }

    const sourceSummary = [...sourceCounts.entries()].map(([key, count]) => `${key}:${count}`).join(', ');
    const statusSummary = [...statusCounts.entries()].map(([key, count]) => `${key}:${count}`).join(', ');
    console.log(
      `  [verify] batch verification updated ${decisions.size} top candidates ` +
      `(sources=${sourceSummary}; status=${statusSummary})`
    );
  }

  private isMicroTimeboxMarket(title: string): boolean {
    const normalized = (title || '').toLowerCase();
    if (!normalized) return false;
    if (/\b\d{1,2}:\d{2}\s*(am|pm)\s*-\s*\d{1,2}:\d{2}\s*(am|pm)\s*et\b/i.test(normalized)) {
      return true;
    }
    if (/\b(up|down)\b.+\b(up|down)\b/.test(normalized) && /\b(et|eastern)\b/.test(normalized)) {
      return true;
    }
    return /up or down\s*-\s*.+\bet\b/i.test(normalized);
  }

  private getDirectionalInstabilityPenalty(
    recentSignals: Array<{ [key: string]: any }>,
    signal: GeneratedSignal
  ): { penalty: number; sameDirection: number; oppositeDirection: number } {
    const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
    const opposite = direction === 'bull' ? 'bear' : 'bull';
    const cutoffMs = Date.now() - (75 * 60 * 1000);

    let sameDirection = 0;
    let oppositeDirection = 0;

    for (const existing of recentSignals) {
      if (existing.matched_asset_id !== signal.matched_asset_id) continue;
      const tsRaw = String(existing.timestamp || '');
      const ts = Date.parse(tsRaw.replace(' ', 'T') + (tsRaw.endsWith('Z') ? '' : 'Z'));
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;

      const action = String(existing.suggested_action || '').toLowerCase();
      if (action.includes(direction)) sameDirection += 1;
      if (action.includes(opposite)) oppositeDirection += 1;
    }

    if (sameDirection >= 2 && oppositeDirection >= 2) {
      return { penalty: 12, sameDirection, oppositeDirection };
    }

    if (oppositeDirection >= 3 && oppositeDirection > sameDirection) {
      return { penalty: 8, sameDirection, oppositeDirection };
    }

    return { penalty: 0, sameDirection, oppositeDirection };
  }
}
