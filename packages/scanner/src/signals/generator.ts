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
import { isNoiseMarketQuestion, isCircularMarket } from '../polymarket/noise-filter.js';
import { SourceCatalyst } from '../sources/types.js';
import { parseDbTimestampMs } from '../utils/time.js';

const DEDUP_WINDOW_HOURS = 4;
const DEDUP_ESCALATION_THRESHOLD_PCT = 5;
const CONTEXT_DEPENDENT_MAX_CONFIDENCE = 40;
const PROXY_CLUSTER_WINDOW_HOURS = 12;
const CATALYST_SIGNAL_WINDOW_MINUTES = 60;
const CATALYST_REEMIT_MINUTES = 10;

// Assets that have many low-quality "Up or Down" price-following markets on Polymarket.
// Capped at 1 per cycle so they don't crowd out oil/defense/Swedish signals.
const NOISY_ASSET_CAP: Record<string, number> = {
  'ev-tesla': 1,
  'crypto-coinbase': 1,
};
const DEFAULT_ASSET_CAP = 3;
const CONTEXT_EFFECT_POSITIVE_PATTERNS: Record<string, RegExp[]> = {
  sp500: [
    /\brate cut(s)?\b/i,
    /\bfed cut\b/i,
    /\bsoft landing\b/i,
    /\bstimulus\b/i,
    /\bconsumer spending\b/i,
    /\bretail sales\b/i,
    /\bgdp growth\b/i,
    /\bjobs growth\b/i,
    /\bdisinflation\b/i
  ],
  nasdaq100: [
    /\brate cut(s)?\b/i,
    /\bsoft landing\b/i,
    /\btech sector outlook\b/i,
    /\brisk-on\b/i,
    /\bai spending\b/i,
    /\bgrowth rebound\b/i
  ],
  omx30: [
    /\briksbank cut\b/i,
    /\brate cut(s)?\b/i,
    /\bswedish gdp growth\b/i,
    /\bconsumer spending\b/i,
    /\bretail sales\b/i,
    /\brisk-on\b/i
  ],
  'retail-hm': [
    /\bconsumer spending\b/i,
    /\bretail sales\b/i,
    /\bclothing demand\b/i,
    /\bapparel demand\b/i,
    /\becommerce\b/i
  ],
  'tech-spotify': [
    /\bsubscriber growth\b/i,
    /\bpremium growth\b/i,
    /\badvertising growth\b/i,
    /\blicensing deal\b/i,
    /\broyalty cut\b/i
  ]
};
const CONTEXT_EFFECT_NEGATIVE_PATTERNS: Record<string, RegExp[]> = {
  sp500: [
    /\bno\b.{0,16}\brate cut(s)?\b/i,
    /\bwithout\b.{0,16}\brate cut(s)?\b/i,
    /\bzero\b.{0,16}\brate cut(s)?\b/i,
    /\brate hike(s)?\b/i,
    /\bfomc hike\b/i,
    /\bfed hike\b/i,
    /\bhike rates?\b/i,
    /\bhigher for longer\b/i,
    /\bhawkish\b/i,
    /\brecession\b/i,
    /\bstock market crash\b/i,
    /\btrade war\b/i,
    /\btariff(s)?\b/i,
    /\binflation\b/i,
    /\bdefault\b/i
  ],
  nasdaq100: [
    /\bno\b.{0,16}\brate cut(s)?\b/i,
    /\bwithout\b.{0,16}\brate cut(s)?\b/i,
    /\bzero\b.{0,16}\brate cut(s)?\b/i,
    /\brate hike(s)?\b/i,
    /\bfed hike\b/i,
    /\bhike rates?\b/i,
    /\bhigher for longer\b/i,
    /\bhawkish\b/i,
    /\brecession\b/i,
    /\bantitrust\b/i,
    /\bbreakup\b/i,
    /\btech crackdown\b/i,
    /\bregulation\b/i,
    /\bexport control\b/i
  ],
  omx30: [
    /\bno\b.{0,16}\brate cut(s)?\b/i,
    /\bwithout\b.{0,16}\brate cut(s)?\b/i,
    /\bzero\b.{0,16}\brate cut(s)?\b/i,
    /\briksbank hike\b/i,
    /\brate hike(s)?\b/i,
    /\bhike rates?\b/i,
    /\bhigher for longer\b/i,
    /\bhawkish\b/i,
    /\brecession\b/i,
    /\btrade war\b/i,
    /\btariff(s)?\b/i,
    /\bswedish inflation\b/i,
    /\beurozone recession\b/i
  ],
  'retail-hm': [
    /\bfast fashion ban\b/i,
    /\btextile regulation\b/i,
    /\bclothing import tariff\b/i,
    /\bapparel tariff\b/i,
    /\bretail tariff\b/i,
    /\bcotton price\b/i,
    /\bsupply chain\b/i
  ],
  'tech-spotify': [
    /\bstreaming royalty\b/i,
    /\bmusic royalty\b/i,
    /\broyalty rate\b/i,
    /\bmusic licensing\b/i,
    /\bdigital music license\b/i
  ]
};

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
    let proxyClusterSkipped = 0;
    let thesisDedupSkipped = 0;
    const cycleAbsDeltaByKey = new Map<string, number>();
    const cycleClusterCounts = new Map<string, number>();
    const cycleBestByThesis = new Map<string, GeneratedSignal>();
    const cycleProxyClusterBySignal = new Map<string, string>();
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
      if (market.title) {
        const titleLower = market.title.toLowerCase();
        if (/\b(settle|close|end)\b.+\b(above|below|at)\b.+\$[\d,]+/i.test(titleLower)) {
          continue;
        }
        if (/\b(close|finish|end)\b.+\b(above|below)\b.+\d{3,}/i.test(titleLower)) {
          continue;
        }
        if (/\b(bitcoin|ethereum|btc|eth)\b.+\$[\d,]+\b.+(by|before|in|on)\b/i.test(titleLower)) {
          continue;
        }
        if (/\b(reach|hit|touch|cross)\b.+\$[\d,]+/i.test(titleLower)) {
          continue;
        }
        if (/\b(dip|drop|fall|rise|rally|trade)\b.{0,16}\bto\b.+\$[\d,]+/i.test(titleLower)) {
          continue;
        }
        if (isCircularMarket(market.title)) {
          console.log(`  [circular] skipping self-referential market: ${market.title}`);
          continue;
        }
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

          // Penalize same-day resolution "Up or Down" markets — they follow price action,
          // not causal events. "Tesla Up or Down on March 31?" has no predictive thesis.
          if (
            /up or down/i.test(market.title) &&
            /\bon\s+\w+\s+\d+/i.test(market.title) &&
            !isMicroTimebox // already penalised above
          ) {
            signal.confidence = Math.max(0, signal.confidence - 20);
            signal.reasoning += ' [same-day-resolution:-20]';
          }

          const instability = this.getDirectionalInstabilityPenalty(recentSignals, signal);
          if (instability.penalty > 0) {
            signal.confidence = Math.max(0, signal.confidence - instability.penalty);
            signal.reasoning +=
              ` [instability:-${instability.penalty} same:${instability.sameDirection}` +
              ` opp:${instability.oppositeDirection}]`;
          }

          const marketChurn = this.getSameMarketChurnPenalty(recentSignals, signal);
          if (marketChurn.penalty > 0) {
            signal.confidence = Math.max(0, signal.confidence - marketChurn.penalty);
            signal.reasoning +=
              ` [market_churn:-${marketChurn.penalty} recent:${marketChurn.totalRecent}` +
              ` flips:${marketChurn.oppositeDirection}]`;
          }

          const proxyContext = this.getProxyMarketContext(market.title, signal.matched_asset_id);
          if (proxyContext) {
            signal.reasoning += ` [proxy:${proxyContext.clusterKey}]`;
            if (proxyContext.penalty > 0) {
              signal.confidence = Math.max(0, signal.confidence - proxyContext.penalty);
              signal.reasoning += ` [proxy_penalty:-${proxyContext.penalty}]`;
            }

            const proxyPenalty = this.getProxyClusterPenalty(recentSignals, signal, proxyContext.clusterKey);
            if (proxyPenalty.penalty > 0) {
              signal.confidence = Math.max(0, signal.confidence - proxyPenalty.penalty);
              signal.reasoning +=
                ` [proxy_cluster:-${proxyPenalty.penalty} recent:${proxyPenalty.recentCount}` +
                ` flips:${proxyPenalty.oppositeDirection}]`;
            }
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

          // Per-asset cap: noisy assets (Tesla, Coinbase) limited to 1; others to 3
          const assetCap = NOISY_ASSET_CAP[signal.matched_asset_id] ?? DEFAULT_ASSET_CAP;
          const assetCountThisCycle = signals.filter(s => s.matched_asset_id === signal.matched_asset_id).length;
          if (assetCountThisCycle >= assetCap) {
            continue; // silent skip — not worth logging every one
          }

          if (proxyContext) {
            const directionTag = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
            const clusterCycleKey = `${proxyContext.clusterKey}:${directionTag}`;
            const clusterCount = cycleClusterCounts.get(clusterCycleKey) || 0;
            if (clusterCount >= proxyContext.maxPerCycle) {
              proxyClusterSkipped += 1;
              if (proxyClusterSkipped <= 12) {
                console.log(
                  `  [cluster] skipping ${mapping.assetName} proxy cluster ${proxyContext.clusterKey} ` +
                  `(cycle ${clusterCount + 1} > max ${proxyContext.maxPerCycle})`
                );
              }
              continue;
            }
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

          const thesisDirection = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
          const thesisKey = `${signal.matched_asset_id}:${thesisDirection}`;
          const existingThesisBest = cycleBestByThesis.get(thesisKey);
          if (existingThesisBest) {
            if (signal.confidence <= existingThesisBest.confidence) {
              thesisDedupSkipped += 1;
              if (thesisDedupSkipped <= 12) {
                console.log(
                  `  [thesis] skipping lower-confidence duplicate thesis for ${mapping.assetName} ` +
                  `(${signal.confidence}% <= ${existingThesisBest.confidence}%)`
                );
              }
              continue;
            }

            this.signalStore.delete(existingThesisBest.id);
            const existingIndex = signals.findIndex(existingSignal => existingSignal.id === existingThesisBest.id);
            if (existingIndex >= 0) {
              signals.splice(existingIndex, 1);
            }
            const candidateIndex = batchCandidates.findIndex(candidate => candidate.signalId === existingThesisBest.id);
            if (candidateIndex >= 0) {
              batchCandidates.splice(candidateIndex, 1);
            }
            const recentIndex = recentSignals.findIndex(existingSignal => String(existingSignal.id) === existingThesisBest.id);
            if (recentIndex >= 0) {
              recentSignals.splice(recentIndex, 1);
            }
            const existingClusterKey = cycleProxyClusterBySignal.get(existingThesisBest.id);
            if (existingClusterKey) {
              const nextCount = Math.max(0, (cycleClusterCounts.get(existingClusterKey) || 0) - 1);
              if (nextCount === 0) {
                cycleClusterCounts.delete(existingClusterKey);
              } else {
                cycleClusterCounts.set(existingClusterKey, nextCount);
              }
              cycleProxyClusterBySignal.delete(existingThesisBest.id);
            }
          }

          signals.push(signal);
          this.signalStore.insert(signal);
          cycleBestByThesis.set(thesisKey, signal);
          cycleAbsDeltaByKey.set(signal.deduplication_key, Math.abs(signal.delta_pct));
          if (proxyContext) {
            const directionTag = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
            const clusterCycleKey = `${proxyContext.clusterKey}:${directionTag}`;
            cycleClusterCounts.set(clusterCycleKey, (cycleClusterCounts.get(clusterCycleKey) || 0) + 1);
            cycleProxyClusterBySignal.set(signal.id, clusterCycleKey);
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
    if (proxyClusterSkipped > 12) {
      console.log(`  [cluster] skipped ${proxyClusterSkipped - 12} additional proxy-cluster signals (suppressed)`);
    }
    if (thesisDedupSkipped > 12) {
      console.log(`  [thesis] skipped ${thesisDedupSkipped - 12} additional duplicate theses (suppressed)`);
    }

    if (batchCandidates.length > 0) {
      await this.applyBatchVerification(batchCandidates, signals);
    }

    return signals;
  }

  /**
   * Generate signals from catalyst convergence (non-Polymarket origins).
   * A signal is emitted only when 2+ independent source families align on the
   * same asset and direction inside a tight time window.
   */
  async generateCatalystSignals(catalysts: SourceCatalyst[]): Promise<GeneratedSignal[]> {
    const recentSignals = this.signalStore.findFiltered({ hours: 48, limit: 500 });
    const windowStartMs = Date.now() - (CATALYST_SIGNAL_WINDOW_MINUTES * 60 * 1000);
    const eligible = catalysts
      .filter(catalyst => catalyst.directionHint !== 'neutral')
      .filter(catalyst => {
        const timestampMs = parseDbTimestampMs(catalyst.timestamp);
        return Number.isFinite(timestampMs) && timestampMs >= windowStartMs;
      });

    if (eligible.length === 0) {
      return [];
    }

    const grouped = new Map<string, SourceCatalyst[]>();
    for (const catalyst of eligible) {
      const key = `${catalyst.assetId}:${catalyst.directionHint}`;
      const bucket = grouped.get(key) || [];
      bucket.push(catalyst);
      grouped.set(key, bucket);
    }

    const signals: GeneratedSignal[] = [];
    const batchCandidates: BatchVerificationCandidate[] = [];

    for (const [groupKey, bucket] of grouped.entries()) {
      const [assetId, direction] = groupKey.split(':') as [string, 'bull' | 'bear'];
      const mapping = this.autoMapper.getMappingForAsset(assetId);
      if (!mapping) continue;

      const byFamily = new Map<string, SourceCatalyst>();
      for (const catalyst of bucket.sort((a, b) => b.timestamp.localeCompare(a.timestamp))) {
        const family = this.getCatalystFamilyKey(catalyst.sourceType);
        if (!byFamily.has(family)) {
          byFamily.set(family, catalyst);
        }
      }

      const alignedCatalysts = Array.from(byFamily.values());
      if (alignedCatalysts.length < 2) {
        continue;
      }

      const familySet = new Set(Array.from(byFamily.keys()));
      const hasTechnical = familySet.has('technical');
      const hasNewsLike = familySet.has('news') || familySet.has('macro') || familySet.has('volume');
      const hasInsider = familySet.has('insider');
      const hasNonPriceCatalystFamily = Array.from(familySet).some(family => !['technical', 'volume'].includes(family));
      const sourceCount = alignedCatalysts.length;
      if (!hasNonPriceCatalystFamily) {
        continue;
      }
      const avgWeight = alignedCatalysts.reduce((sum, catalyst) => sum + (catalyst.sourceWeight || 1), 0) / sourceCount;
      const totalBoost = alignedCatalysts.reduce((sum, catalyst) => {
        const metadataBoost = typeof catalyst.metadata?.totalBoost === 'number'
          ? catalyst.metadata.totalBoost
          : 0;
        return sum + metadataBoost;
      }, 0);

      let confidence = sourceCount >= 3 ? 65 : 52;
      confidence += Math.round((avgWeight - 1) * 20);
      confidence += sourceCount >= 4 ? 8 : (sourceCount >= 3 ? 4 : 0);
      if (hasTechnical && hasNewsLike) confidence += 10;
      if (hasInsider) confidence += 3;
      if (familySet.has('macro')) confidence += 8;
      if (familySet.has('volume')) confidence += 5;
      if (hasTechnical && hasNewsLike && familySet.has('macro')) confidence += 6;
      confidence += Math.min(8, Math.round(totalBoost / 5));
      confidence = Math.max(40, Math.min(confidence, 88));

      let syntheticDeltaPct = sourceCount >= 3 ? 28 : 18;
      if (hasTechnical && hasNewsLike) syntheticDeltaPct += 6;
      if (hasInsider) syntheticDeltaPct += 3;
      if (familySet.has('macro')) syntheticDeltaPct += 4;
      syntheticDeltaPct = Math.max(12, Math.min(syntheticDeltaPct, 36));

      const syntheticMarket = this.buildCatalystMarket(mapping.assetId, mapping.assetName, direction, alignedCatalysts);
      this.marketStore.insert(syntheticMarket);

      const signal = this.createCatalystSignal(
        syntheticMarket,
        mapping,
        direction,
        alignedCatalysts,
        confidence,
        syntheticDeltaPct
      );

      const existing = this.signalStore.findRecentByDeduplicationKey(signal.deduplication_key, DEDUP_WINDOW_HOURS);
      if (existing) {
        const existingCatalystScore = Number(existing.catalyst_score || 0);
        const existingTimestamp = this.parseSignalTimestamp(existing.timestamp);
        const minutesSinceExisting = existingTimestamp
          ? (Date.now() - existingTimestamp.getTime()) / 60000
          : Number.POSITIVE_INFINITY;
        const canReemitUnpushedCatalyst =
          String(existing.signal_origin || 'polymarket') === 'catalyst_convergence' &&
          !existing.push_sent_at &&
          Number.isFinite(minutesSinceExisting) &&
          minutesSinceExisting >= CATALYST_REEMIT_MINUTES &&
          sourceCount >= Math.max(2, Math.round(existingCatalystScore)) &&
          signal.confidence >= existing.confidence - 2;

        if (!canReemitUnpushedCatalyst) {
          if (
            signal.confidence <= existing.confidence + 4 &&
            sourceCount <= Math.max(2, Math.round(existingCatalystScore))
          ) {
            continue;
          }
        }
      }

      const verificationContext: VerificationContext = {
        marketTitle: signal.market_title,
        marketDescription: syntheticMarket.description,
        marketCategory: syntheticMarket.category,
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
        ontologyKeywords: alignedCatalysts.map(catalyst => catalyst.sourceType),
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
      signal.confidence = Math.max(0, Math.min(signal.confidence + verification.confidenceAdjustment, 92));
      signal.reasoning +=
        ` [catalysts:${sourceCount}] [families:${Array.from(familySet).join('+')}]` +
        ` [score: base:${confidence}, verify:${verification.confidenceAdjustment >= 0 ? '+' : ''}${verification.confidenceAdjustment}]`;

      if (signal.confidence < 42) {
        continue;
      }

      this.signalStore.insert(signal);
      signals.push(signal);

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

      recentSignals.unshift({
        ...signal,
        timestamp: new Date().toISOString(),
        suggested_instruments: JSON.stringify(signal.suggested_instruments),
        ai_analysis: null,
        status: 'new'
      } as any);

      console.log(
        `  [catalyst] ${signal.suggested_action} ${mapping.assetName} ` +
        `(${sourceCount} sources, confidence ${signal.confidence}%)`
      );
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
      const direction = this.resolveContextDependentDirection(change, market, mapping);
      return direction
        ? [this.createSignal(change, market, mapping, whaleDetected, whaleAmountUsd, direction)]
        : [];
    }

    const oddsIncreasing = change.delta_pct > 0;
    const direction = this.autoMapper.determineTradingDirection(
      mapping.polarity,
      oddsIncreasing
    ) as 'bull' | 'bear';

    return [this.createSignal(change, market, mapping, whaleDetected, whaleAmountUsd, direction)];
  }

  private resolveContextDependentDirection(
    change: OddsChange,
    market: { title?: string | null; description?: string | null },
    mapping: CorrelationMapping
  ): 'bull' | 'bear' | null {
    const effect = this.inferContextDependentEffect(mapping.assetId, market.title, market.description);
    if (!effect) {
      return null;
    }

    const oddsIncreasing = change.delta_pct > 0;
    return oddsIncreasing ? effect : (effect === 'bull' ? 'bear' : 'bull');
  }

  private inferContextDependentEffect(
    assetId: string,
    title?: string | null,
    description?: string | null
  ): 'bull' | 'bear' | null {
    const text = `${String(title || '')} ${String(description || '')}`.toLowerCase();
    const positiveText = this.stripNegatedPositivePhrases(text);
    const positivePatterns = CONTEXT_EFFECT_POSITIVE_PATTERNS[assetId] || [];
    const negativePatterns = CONTEXT_EFFECT_NEGATIVE_PATTERNS[assetId] || [];
    const positiveMatches = positivePatterns.filter(pattern => pattern.test(positiveText)).length;
    const negativeMatches = negativePatterns.filter(pattern => pattern.test(text)).length;

    if (positiveMatches === 0 && negativeMatches === 0) {
      return null;
    }
    if (positiveMatches === negativeMatches) {
      return null;
    }
    return positiveMatches > negativeMatches ? 'bull' : 'bear';
  }

  private stripNegatedPositivePhrases(text: string): string {
    return text
      .replace(/\b(no|without|zero)\b.{0,16}\brate cut(s)?\b/gi, ' ')
      .replace(/\bfail(s|ed)? to\b.{0,16}\brate cut(s)?\b/gi, ' ');
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
      signal_origin: 'polymarket',
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

  private createCatalystSignal(
    market: {
      condition_id: string;
      slug: string;
      title: string;
      description: string | null;
      category: string | null;
    },
    mapping: CorrelationMapping,
    direction: 'bull' | 'bear',
    catalysts: SourceCatalyst[],
    confidence: number,
    syntheticDeltaPct: number
  ): GeneratedSignal {
    const instruments = this.autoMapper.getSuggestedInstruments(mapping, direction);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
    const id = `sig_${timestamp}_${Math.random().toString(36).substring(2, 8)}`;
    const deduplicationKey = `catalyst_${mapping.assetId}_${direction}`;
    const primaryCatalyst = catalysts[0];
    const catalystTitles = catalysts.map(catalyst => catalyst.title).slice(0, 3).join(' | ');

    return {
      id,
      signal_origin: 'catalyst_convergence',
      market_condition_id: market.condition_id,
      market_slug: market.slug,
      market_title: market.title,
      odds_before: 0,
      odds_now: 0,
      delta_pct: syntheticDeltaPct,
      time_window_minutes: CATALYST_SIGNAL_WINDOW_MINUTES,
      whale_detected: false,
      whale_amount_usd: null,
      matched_asset_id: mapping.assetId,
      matched_asset_name: mapping.assetName,
      polarity: 'direct',
      suggested_action: `Consider ${direction.toUpperCase()} position`,
      suggested_instruments: instruments,
      reasoning:
        `Catalyst convergence: ${catalysts.length} aligned sources point ${direction.toUpperCase()} ` +
        `${mapping.assetName}. Lead catalyst: ${primaryCatalyst?.title || market.title}. ` +
        `Evidence: ${catalystTitles}.`,
      confidence,
      requires_judgment: false,
      deduplication_key: deduplicationKey,
      verification_status: 'pending',
      verification_score: 0,
      verification_reason: 'Pending verification',
      verification_flags: [],
      verification_source: 'none',
      verification_record: null,
      catalyst_score: catalysts.length
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

  private parseSignalTimestamp(value: unknown): Date | null {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const withZone = /z$/i.test(normalized) ? normalized : `${normalized}Z`;
    const parsed = new Date(withZone);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
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

  private getSameMarketChurnPenalty(
    recentSignals: Array<{ [key: string]: any }>,
    signal: GeneratedSignal
  ): { penalty: number; totalRecent: number; oppositeDirection: number } {
    const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
    const opposite = direction === 'bull' ? 'bear' : 'bull';
    const cutoffMs = Date.now() - (24 * 60 * 60 * 1000);

    let totalRecent = 0;
    let oppositeDirection = 0;

    for (const existing of recentSignals) {
      if (existing.matched_asset_id !== signal.matched_asset_id) continue;
      if (existing.market_condition_id !== signal.market_condition_id) continue;
      const tsRaw = String(existing.timestamp || '');
      const ts = Date.parse(tsRaw.replace(' ', 'T') + (tsRaw.endsWith('Z') ? '' : 'Z'));
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;

      totalRecent += 1;
      const action = String(existing.suggested_action || '').toLowerCase();
      if (action.includes(opposite)) {
        oppositeDirection += 1;
      }
    }

    if (totalRecent >= 8 && oppositeDirection >= 3) {
      return { penalty: 18, totalRecent, oppositeDirection };
    }
    if (totalRecent >= 6 && oppositeDirection >= 2) {
      return { penalty: 12, totalRecent, oppositeDirection };
    }
    if (totalRecent >= 4 && oppositeDirection >= 1) {
      return { penalty: 6, totalRecent, oppositeDirection };
    }

    return { penalty: 0, totalRecent, oppositeDirection };
  }

  private getProxyMarketContext(
    title: string,
    assetId: string
  ): { clusterKey: string; penalty: number; maxPerCycle: number } | null {
    const normalized = String(title || '').toLowerCase();
    if (assetId === 'crypto-coinbase') {
      if (/\bup or down\b/.test(normalized) && /\b(et|eastern)\b/.test(normalized)) {
        return { clusterKey: 'crypto_proxy_intraday', penalty: 28, maxPerCycle: 1 };
      }

      if (/\baverage monthly\b.+\b(gas price|gwei)\b/.test(normalized)) {
        return { clusterKey: 'crypto_proxy_metric', penalty: 16, maxPerCycle: 1 };
      }

      if (
        /\bprice of\b.*\b(bitcoin|ethereum|solana|btc|eth)\b/.test(normalized) ||
        /\b(bitcoin|ethereum|solana|btc|eth)\b.*\b(above|below|between|reach|hit|over|under|dip to)\b/.test(normalized) ||
        /\$\d[\d,]*\s*-\s*\$\d[\d,]*/.test(normalized)
      ) {
        return { clusterKey: 'crypto_proxy_price', penalty: 26, maxPerCycle: 1 };
      }
      return null;
    }

    if (assetId.startsWith('oil-')) {
      if (
        /\b(crude oil|wti|brent|cl)\b/.test(normalized) &&
        (/\bprice of\b/.test(normalized) ||
          /\b(above|below|between|reach|hit|over|under|dip to)\b/.test(normalized) && /\$\d/.test(normalized) ||
          /\$\d[\d,]*\s*-\s*\$\d[\d,]*/.test(normalized))
      ) {
        return { clusterKey: 'commodity_proxy_price', penalty: 24, maxPerCycle: 1 };
      }
      return null;
    }

    if (assetId === 'ev-tesla') {
      if (
        /\b(tesla|tsla)\b/.test(normalized) &&
        (/\bclose above|close below|dip to\b/.test(normalized) ||
          /\b(above|below|between|reach|hit|over|under)\b/.test(normalized) && /\$\d/.test(normalized) ||
          /\$\d[\d,]*\s*-\s*\$\d[\d,]*/.test(normalized))
      ) {
        return { clusterKey: 'equity_proxy_price', penalty: 22, maxPerCycle: 1 };
      }
      return null;
    }

    if (assetId === 'sp500' || assetId === 'nasdaq100' || assetId === 'omx30') {
      if (
        /\b(s&p 500|sp500|nasdaq|omx)\b/.test(normalized) &&
        (/\bclose above|close below\b/.test(normalized) ||
          /\b(above|below|between|reach|hit|over|under)\b/.test(normalized) && /\d/.test(normalized))
      ) {
        return { clusterKey: 'index_proxy_price', penalty: 20, maxPerCycle: 1 };
      }
    }

    return null;
  }

  private getProxyClusterPenalty(
    recentSignals: Array<{ [key: string]: any }>,
    signal: GeneratedSignal,
    clusterKey: string
  ): { penalty: number; recentCount: number; oppositeDirection: number } {
    const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
    const opposite = direction === 'bull' ? 'bear' : 'bull';
    const cutoffMs = Date.now() - (PROXY_CLUSTER_WINDOW_HOURS * 60 * 60 * 1000);
    const proxyTag = `[proxy:${clusterKey}]`;

    let recentCount = 0;
    let oppositeDirection = 0;

    for (const existing of recentSignals) {
      if (existing.matched_asset_id !== signal.matched_asset_id) continue;
      const reasoning = String(existing.reasoning || '');
      if (!reasoning.includes(proxyTag)) continue;
      const tsRaw = String(existing.timestamp || '');
      const ts = Date.parse(tsRaw.replace(' ', 'T') + (tsRaw.endsWith('Z') ? '' : 'Z'));
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;

      recentCount += 1;
      const action = String(existing.suggested_action || '').toLowerCase();
      if (action.includes(opposite)) {
        oppositeDirection += 1;
      }
    }

    if (recentCount >= 8) {
      return { penalty: 18, recentCount, oppositeDirection };
    }
    if (recentCount >= 5) {
      return { penalty: 12, recentCount, oppositeDirection };
    }
    if (recentCount >= 3) {
      return { penalty: 6, recentCount, oppositeDirection };
    }

    return { penalty: 0, recentCount, oppositeDirection };
  }

  private buildCatalystMarket(
    assetId: string,
    assetName: string,
    direction: 'bull' | 'bear',
    catalysts: SourceCatalyst[]
  ) {
    const latestTimestamp = catalysts
      .map(catalyst => parseDbTimestampMs(catalyst.timestamp))
      .filter(value => Number.isFinite(value))
      .sort((a, b) => b - a)[0] || Date.now();
    const familySummary = [...new Set(catalysts.map(catalyst => this.getCatalystFamilyKey(catalyst.sourceType)))].join('-');
    const slugBase = `${assetId}-${direction}-${familySummary}-${new Date(latestTimestamp).toISOString().slice(0, 16)}`;
    const conditionId = `catalyst_${assetId}_${direction}_${this.hashText(slugBase)}`;
    const leadTitle = catalysts[0]?.title || `${assetName} catalyst convergence`;
    const description = catalysts
      .slice(0, 4)
      .map(catalyst => `[${this.getCatalystFamilyKey(catalyst.sourceType)}] ${catalyst.title}`)
      .join(' | ');

    return {
      condition_id: conditionId,
      gamma_id: null,
      slug: `catalyst-${assetId}-${direction}-${this.hashText(leadTitle)}`,
      event_slug: null,
      title: `${assetName}: ${leadTitle}`,
      description,
      category: 'external_catalyst',
      matched_asset_ids: [assetId],
      relevance_score: 1,
      volume: null,
      liquidity: null
    };
  }

  private getCatalystFamilyKey(sourceType: SourceCatalyst['sourceType']): string {
    if (sourceType === 'technical_breakout') return 'technical';
    if (sourceType === 'econ_surprise') return 'macro';
    if (sourceType === 'finviz_news') return 'news';
    if (sourceType === 'finviz_volume') return 'volume';
    if (sourceType === 'finviz_insider' || sourceType === 'congressional_trade' || sourceType === 'sec_insider') {
      return 'insider';
    }
    return sourceType;
  }

  private hashText(value: string): string {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}
