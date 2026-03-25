import { createHash } from 'crypto';
import { GeneratedSignal } from '../signals/types.js';
import { CatalystStore } from '../storage/catalyst-store.js';
import { CatalystNormalizer, CatalystDirectionHint } from './catalyst-normalizer.js';
import { ExecutionReplayService } from './execution-replay.js';
import { SourceDiagnosticsService } from './source-diagnostics.js';
import { NewsCorrelator } from './news-correlator.js';
import { MacroCalendar } from './macro-calendar.js';
import { SignalStore } from '../storage/signal-store.js';
import { IngestedCatalyst, SourceCatalyst, SourceCatalystType } from '../sources/types.js';

interface CatalystEngineDeps {
  catalystStore: CatalystStore;
  signalStore: SignalStore;
  sourceDiagnostics: SourceDiagnosticsService;
  executionReplay: ExecutionReplayService;
}

function hashKey(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class CatalystEngine {
  private normalizer = new CatalystNormalizer();
  private historicalBackfillCompleted = false;

  constructor(private deps: CatalystEngineDeps) {}

  ingestExternalCatalysts(catalysts: SourceCatalyst[]): IngestedCatalyst[] {
    if (catalysts.length === 0) return [];

    const ingested: IngestedCatalyst[] = [];
    for (const catalyst of catalysts) {
      const sourceType = this.mapSourceType(catalyst.sourceType);
      const sourceWeight = catalyst.sourceWeight || this.getSourceWeight(catalyst);
      const draft = this.normalizer.normalize({
        sourceType,
        title: catalyst.title,
        body: catalyst.body,
        assetId: catalyst.assetId,
        assetName: catalyst.assetName,
        hintedDirection: catalyst.directionHint === 'neutral' ? 'mixed' : catalyst.directionHint,
        sourceWeight
      });
      const recentSimilarCount = this.deps.catalystStore.countRecentSimilar(
        catalyst.assetId,
        draft.sourceFamily,
        24
      );
      const normalized = this.normalizer.normalize({
        sourceType,
        title: catalyst.title,
        body: catalyst.body,
        assetId: catalyst.assetId,
        assetName: catalyst.assetName,
        hintedDirection: catalyst.directionHint === 'neutral' ? 'mixed' : catalyst.directionHint,
        sourceWeight,
        recentSimilarCount
      });

      const catalystId = this.deps.catalystStore.upsertCatalyst({
        sourceType: catalyst.sourceType,
        sourceKey: catalyst.sourceKey,
        sourceFamily: normalized.sourceFamily,
        eventType: normalized.eventType,
        title: catalyst.title,
        body: catalyst.body,
        assetIds: [catalyst.assetId],
        directionHint: normalized.directionHint,
        horizonMinutes: normalized.horizonMinutes,
        causalStrength: normalized.causalStrength,
        noveltyScore: normalized.noveltyScore,
        sourceQualityScore: normalized.sourceQualityScore,
        normalizedSummary: normalized.normalizedSummary,
        metadata: {
          ticker: catalyst.ticker,
          urgency: catalyst.urgency,
          ...catalyst.metadata
        },
        catalystTime: catalyst.timestamp
      });

      ingested.push({
        ...catalyst,
        catalystId,
        sourceFamily: normalized.sourceFamily,
        eventType: normalized.eventType,
        horizonMinutes: normalized.horizonMinutes,
        causalStrength: normalized.causalStrength,
        noveltyScore: normalized.noveltyScore,
        sourceQualityScore: normalized.sourceQualityScore,
        normalizedSummary: normalized.normalizedSummary
      });
    }

    return ingested;
  }

  enrichSignals(
    signals: GeneratedSignal[],
    overrides?: { newsCorrelator?: NewsCorrelator | null; macroCalendar?: MacroCalendar | null }
  ): void {
    this.deps.sourceDiagnostics.refreshIfStale();
    const newsCorrelator = overrides?.newsCorrelator ?? null;
    const macroCalendar = overrides?.macroCalendar ?? null;

    for (const signal of signals) {
      const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
      const primaryDraft = this.normalizePrimarySignal(signal, direction);
      const recentSimilarCount = this.deps.catalystStore.countRecentSimilar(
        signal.matched_asset_id,
        primaryDraft.sourceFamily,
        24
      );
      const primary = this.normalizePrimarySignal(signal, direction, recentSimilarCount);

      const primaryCatalystId = this.deps.catalystStore.upsertCatalyst({
        sourceType: 'polymarket',
        sourceKey: `polymarket:${signal.id}`,
        sourceFamily: primary.sourceFamily,
        eventType: primary.eventType,
        title: signal.market_title,
        body: signal.reasoning,
        assetIds: [signal.matched_asset_id],
        directionHint: primary.directionHint,
        horizonMinutes: primary.horizonMinutes,
        causalStrength: primary.causalStrength,
        noveltyScore: primary.noveltyScore,
        sourceQualityScore: primary.sourceQualityScore,
        normalizedSummary: primary.normalizedSummary,
        metadata: {
          signalId: signal.id,
          deltaPct: signal.delta_pct,
          confidence: signal.confidence,
          whaleDetected: signal.whale_detected
        },
        catalystTime: new Date().toISOString()
      });
      this.deps.catalystStore.linkSignal({
        signalId: signal.id,
        catalystId: primaryCatalystId,
        relation: 'primary',
        evidenceScore: 0.95
      });

      const supportingFamilies = new Set<string>();
      const contradictions: string[] = [];

      if (signal.whale_detected) {
        const whaleCatalystId = this.deps.catalystStore.upsertCatalyst({
          sourceType: 'whale',
          sourceKey: `whale:${signal.id}`,
          sourceFamily: `${primary.sourceFamily}_whale`,
          eventType: 'whale_flow',
          title: `${signal.matched_asset_name} whale flow`,
          body: `${signal.market_title} whale $${Math.round(signal.whale_amount_usd || 0)}`,
          assetIds: [signal.matched_asset_id],
          directionHint: direction,
          horizonMinutes: 60,
          causalStrength: 0.82,
          noveltyScore: 0.75,
          sourceQualityScore: 0.82,
          normalizedSummary: `whale confirms ${direction.toUpperCase()} ${signal.matched_asset_name}`,
          metadata: {
            whaleAmountUsd: signal.whale_amount_usd || 0
          },
          catalystTime: new Date().toISOString()
        });
        this.deps.catalystStore.linkSignal({
          signalId: signal.id,
          catalystId: whaleCatalystId,
          relation: 'supporting',
          evidenceScore: 0.8
        });
        supportingFamilies.add('whale_flow');
      }

      const newsEvidence = newsCorrelator?.getEvidenceForAsset(signal.matched_asset_id, 8, 3) ?? [];
      for (const evidence of newsEvidence) {
        const normalized = this.normalizer.normalize({
          sourceType: 'news',
          title: evidence.text,
          body: evidence.accountHandle,
          assetId: signal.matched_asset_id,
          assetName: signal.matched_asset_name,
          hintedDirection: direction,
          sourceWeight: evidence.weight
        });
        if (normalized.isNoise) continue;

        const catalystId = this.deps.catalystStore.upsertCatalyst({
          sourceType: 'news',
          sourceKey: `news:${evidence.accountHandle}:${hashKey(evidence.text)}`,
          sourceFamily: normalized.sourceFamily,
          eventType: normalized.eventType,
          title: evidence.text,
          body: `source ${evidence.accountHandle}`,
          assetIds: [signal.matched_asset_id],
          directionHint: normalized.directionHint,
          horizonMinutes: normalized.horizonMinutes,
          causalStrength: normalized.causalStrength,
          noveltyScore: normalized.noveltyScore,
          sourceQualityScore: normalized.sourceQualityScore,
          normalizedSummary: normalized.normalizedSummary,
          metadata: {
            accountHandle: evidence.accountHandle,
            matchedTerms: evidence.matchedTerms
          },
          catalystTime: evidence.timestamp
        });

        const relation = this.isContradicting(direction, normalized.directionHint) ? 'contradicting' : 'supporting';
        this.deps.catalystStore.linkSignal({
          signalId: signal.id,
          catalystId,
          relation,
          evidenceScore: clamp(0.55 + (evidence.weight - 1) * 0.1, 0.4, 0.9)
        });

        if (relation === 'supporting') {
          supportingFamilies.add(normalized.sourceFamily);
        } else {
          contradictions.push(normalized.sourceFamily);
        }
      }

      const macro = macroCalendar?.isInEventWindow(signal.matched_asset_id);
      if (macro?.inWindow) {
        const directionHint: CatalystDirectionHint = macro.minutesUntil >= 0 ? direction : 'mixed';
        const catalystId = this.deps.catalystStore.upsertCatalyst({
          sourceType: 'macro',
          sourceKey: `macro:${signal.matched_asset_id}:${hashKey(macro.eventName)}`,
          sourceFamily: 'macro_calendar',
          eventType: 'scheduled_macro',
          title: macro.eventName,
          body: `${macro.impact} impact ${macro.minutesUntil} minutes`,
          assetIds: [signal.matched_asset_id],
          directionHint,
          horizonMinutes: Math.max(15, Math.abs(macro.minutesUntil) + 30),
          causalStrength: macro.impact === 'very_high' ? 0.92 : macro.impact === 'high' ? 0.84 : 0.72,
          noveltyScore: 0.68,
          sourceQualityScore: 0.9,
          normalizedSummary: `macro calendar ${macro.eventName} around ${signal.matched_asset_name}`,
          metadata: { ...macro },
          catalystTime: new Date().toISOString()
        });
        this.deps.catalystStore.linkSignal({
          signalId: signal.id,
          catalystId,
          relation: 'supporting',
          evidenceScore: 0.78
        });
        supportingFamilies.add('macro_calendar');
      }

      const hasProxyCorroboration =
        Boolean(signal.whale_detected) ||
        supportingFamilies.size > 0 ||
        /\[futures:[^\]]*confirms/i.test(signal.reasoning || '');
      const proxyAdjustment =
        primary.sourceFamily === 'crypto_proxy_market' && !hasProxyCorroboration
          ? -18
          : 0;
      const catalystScore = this.computeCatalystScore(primary, supportingFamilies.size, contradictions.length, signal);
      const catalystAdjustment = this.toCatalystAdjustment(catalystScore);
      const diagnostics = this.deps.sourceDiagnostics.assess(primary.sourceFamily);
      const replay = this.deps.executionReplay.assess(signal, primary.sourceFamily);

      signal.primary_source_family = primary.sourceFamily;
      signal.catalyst_score = catalystScore;
      signal.catalyst_summary = [
        primary.normalizedSummary,
        supportingFamilies.size > 0 ? `${supportingFamilies.size} supporting families` : 'no external support',
        contradictions.length > 0 ? `${contradictions.length} contradictions` : null
      ].filter(Boolean).join(' | ');
      signal.execution_replay_gate = replay.gate;
      signal.execution_replay_expectancy_pct = replay.expectancyPct;
      signal.execution_replay_samples = replay.samples;
      signal.execution_replay_win_rate = replay.winRate30m;

      signal.confidence = Math.max(
        0,
        Math.min(
          signal.confidence +
            catalystAdjustment +
            diagnostics.confidenceAdjustment +
            replay.confidenceAdjustment +
            proxyAdjustment,
          92
        )
      );
      signal.reasoning +=
        ` [source:${primary.sourceFamily}]` +
        ` [catalyst:${catalystScore.toFixed(1)} ${signal.catalyst_summary}]` +
        ` [source_diag:${diagnostics.note}]` +
        ` [replay:${replay.note}]` +
        (proxyAdjustment < 0 ? ` [proxy_gate:${proxyAdjustment} uncorroborated]` : '');

      this.deps.signalStore.updateCatalystContext(signal.id, {
        primarySourceFamily: signal.primary_source_family,
        catalystScore,
        catalystSummary: signal.catalyst_summary,
        executionReplayGate: replay.gate,
        executionReplayExpectancyPct: replay.expectancyPct,
        executionReplaySamples: replay.samples,
        executionReplayWinRate: replay.winRate30m,
        confidence: signal.confidence,
        reasoning: signal.reasoning
      });
    }
  }

  backfillHistoricalSignals(days = 45): number {
    if (this.historicalBackfillCompleted) return 0;

    const rows = this.deps.catalystStore.getSignalsMissingPrimaryCatalyst(days);
    for (const row of rows) {
      const direction = row.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
      const normalized = this.normalizer.normalize({
        sourceType: 'polymarket',
        title: row.market_title,
        body: row.reasoning,
        assetId: row.matched_asset_id,
        assetName: row.matched_asset_name,
        hintedDirection: direction,
        sourceWeight: row.whale_detected ? 1.2 : 1.0
      });

      const catalystId = this.deps.catalystStore.upsertCatalyst({
        sourceType: 'polymarket',
        sourceKey: `hist:${row.id}`,
        sourceFamily: normalized.sourceFamily,
        eventType: normalized.eventType,
        title: row.market_title,
        body: row.reasoning,
        assetIds: [row.matched_asset_id],
        directionHint: normalized.directionHint,
        horizonMinutes: normalized.horizonMinutes,
        causalStrength: normalized.causalStrength,
        noveltyScore: normalized.noveltyScore,
        sourceQualityScore: normalized.sourceQualityScore,
        normalizedSummary: normalized.normalizedSummary,
        metadata: {
          signalId: row.id,
          backfilled: true,
          whaleAmountUsd: row.whale_amount_usd || 0
        },
        catalystTime: row.timestamp
      });

      this.deps.catalystStore.linkSignal({
        signalId: row.id,
        catalystId,
        relation: 'primary',
        evidenceScore: 0.9
      });

      this.deps.signalStore.updateCatalystContext(row.id, {
        primarySourceFamily: normalized.sourceFamily,
        catalystScore: this.computeCatalystScore(normalized, 0, 0, {
          whale_detected: Boolean(row.whale_detected)
        } as GeneratedSignal),
        catalystSummary: normalized.normalizedSummary,
        executionReplayGate: 'unknown',
        executionReplayExpectancyPct: 0,
        executionReplaySamples: 0,
        executionReplayWinRate: 0,
        confidence: row.confidence,
        reasoning: row.reasoning
      });
    }

    this.historicalBackfillCompleted = true;
    return rows.length;
  }

  private computeCatalystScore(
    primary: ReturnType<CatalystNormalizer['normalize']>,
    supportingCount: number,
    contradictions: number,
    signal: GeneratedSignal
  ): number {
    let score =
      (primary.causalStrength * 45) +
      (primary.noveltyScore * 20) +
      (primary.sourceQualityScore * 15) +
      (supportingCount * 6);
    if (signal.whale_detected) score += 6;
    score -= contradictions * 8;
    if (primary.isNoise) score -= 20;
    return clamp(score, 0, 100);
  }

  private toCatalystAdjustment(score: number): number {
    if (score >= 80) return 6;
    if (score >= 70) return 4;
    if (score >= 60) return 2;
    if (score <= 30) return -6;
    if (score <= 40) return -3;
    return 0;
  }

  private isContradicting(direction: 'bull' | 'bear', hint: CatalystDirectionHint): boolean {
    return (direction === 'bull' && hint === 'bear') || (direction === 'bear' && hint === 'bull');
  }

  private normalizePrimarySignal(
    signal: GeneratedSignal,
    direction: 'bull' | 'bear',
    recentSimilarCount = 0
  ) {
    if (signal.signal_origin === 'catalyst_convergence') {
      const familyHints = this.extractCatalystFamilies(signal.reasoning || '');
      const noveltyPenalty = Math.min(0.3, recentSimilarCount * 0.08);
      const familySummary = familyHints.length > 0 ? familyHints.join('+') : 'multi_source';
      return {
        sourceFamily: 'catalyst_convergence',
        eventType: 'multi_source_convergence',
        directionHint: direction,
        horizonMinutes: 90,
        causalStrength: 0.86,
        noveltyScore: Math.max(0.2, 0.88 - noveltyPenalty),
        sourceQualityScore: 0.86,
        normalizedSummary: `catalyst convergence ${direction.toUpperCase()} for ${signal.matched_asset_name}: ${familySummary}`,
        isNoise: false
      };
    }

    return this.normalizer.normalize({
      sourceType: 'polymarket',
      title: signal.market_title,
      body: signal.reasoning,
      assetId: signal.matched_asset_id,
      assetName: signal.matched_asset_name,
      hintedDirection: direction,
      sourceWeight: signal.whale_detected ? 1.2 : 1.0,
      recentSimilarCount
    });
  }

  private extractCatalystFamilies(reasoning: string): string[] {
    const match = reasoning.match(/\[families:([^\]]+)\]/i);
    if (!match?.[1]) return [];
    return match[1]
      .split('+')
      .map(part => part.trim())
      .filter(Boolean);
  }

  private mapSourceType(
    sourceType: SourceCatalystType
  ): 'news' | 'macro' | 'whale' | 'polymarket' | 'tweet' | 'technical' | 'insider' | 'volume' {
    if (sourceType === 'finviz_news') return 'news';
    if (sourceType === 'finviz_insider' || sourceType === 'congressional_trade' || sourceType === 'sec_insider') {
      return 'insider';
    }
    if (sourceType === 'finviz_volume') return 'volume';
    if (sourceType === 'technical_breakout') return 'technical';
    if (sourceType === 'econ_surprise') return 'macro';
    return 'news';
  }

  private getSourceWeight(catalyst: SourceCatalyst): number {
    const urgencyWeight = catalyst.urgency === 'high'
      ? 1.2
      : catalyst.urgency === 'medium'
        ? 1.05
        : 0.95;

    if (catalyst.sourceType === 'finviz_insider' || catalyst.sourceType === 'sec_insider') {
      return urgencyWeight + 0.1;
    }
    if (catalyst.sourceType === 'technical_breakout') {
      return urgencyWeight + 0.05;
    }
    return urgencyWeight;
  }
}
