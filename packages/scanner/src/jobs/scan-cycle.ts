import Database from 'better-sqlite3';
import { Config } from '../config.js';
import { OddsTracker } from '../polymarket/odds-tracker.js';
import { WhaleDetector } from '../polymarket/whale-detector.js';
import { SignalGenerator } from '../signals/generator.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';
import { IntelligenceEngine } from '../intelligence/engine.js';
import { NewsCorrelator } from '../intelligence/news-correlator.js';
import { MacroCalendar } from '../intelligence/macro-calendar.js';
import { VolatilityRegimeDetector } from '../intelligence/volatility-regime.js';
import { FuturesConfirmationService } from '../intelligence/futures-confirmation.js';
import { StreamingFeatureService } from '../streaming/services/streaming-feature-service.js';
import { StreamingStore } from '../streaming/storage/streaming-store.js';
import { FusionEngine } from '../streaming/fusion/engine.js';
import { TradeDirection } from '../streaming/fusion/types.js';
import { CatalystEngine } from '../intelligence/catalyst-engine.js';
import { SourceDiagnosticsService } from '../intelligence/source-diagnostics.js';
import { FinvizScanner } from '../sources/finviz-scanner.js';
import { TechnicalScanner } from '../sources/technical-scanner.js';
import { EconCalendarScanner } from '../sources/econ-calendar-scanner.js';
import { InsiderScanner } from '../sources/insider-scanner.js';
import { SourceCatalyst } from '../sources/types.js';

export interface ScanCycleResult {
  marketsTracked: number;
  oddsChangesDetected: number;
  whalesDetected: number;
  signalsGenerated: number;
  haPushed: number;
  brewed: number;
  duration: number;
}

interface FusionGateSummary {
  total: number;
  noInput: number;
  allow: number;
  suppress: number;
  fallbackPhase1: number;
  suppressReasonCounts: Map<string, number>;
}

export class ScanCycleJob {
  private volatilityRegimeDetector = new VolatilityRegimeDetector();
  private futuresConfirmation = new FuturesConfirmationService();
  private intelligence: IntelligenceEngine | null = null;
  private newsCorrelator: NewsCorrelator | null = null;
  private macroCalendar: MacroCalendar | null = null;

  constructor(
    private config: Config,
    private oddsTracker: OddsTracker,
    private whaleDetector: WhaleDetector,
    private signalGenerator: SignalGenerator,
    private alertDispatcher: AlertDispatcher,
    private db?: Database.Database,
    private streamingFeatureService: StreamingFeatureService | null = null,
    private streamingStore?: StreamingStore,
    private fusionEngine?: FusionEngine,
    private catalystEngine?: CatalystEngine,
    private sourceDiagnostics?: SourceDiagnosticsService,
    private finvizScanner?: FinvizScanner,
    private technicalScanner?: TechnicalScanner,
    private econCalendarScanner?: EconCalendarScanner,
    private insiderScanner?: InsiderScanner,
    private fusionOptions: {
      enableFusionGating: boolean;
      enableSuppressedDecisionStorage: boolean;
      enableSecondVenue: boolean;
      enableLiquidations: boolean;
    } = {
      enableFusionGating: false,
      enableSuppressedDecisionStorage: true,
      enableSecondVenue: false,
      enableLiquidations: false
    }
  ) {}

  setStreamingFeatureService(service: StreamingFeatureService | null): void {
    this.streamingFeatureService = service;
  }

  /**
   * Execute one scan cycle.
   */
  async execute(): Promise<ScanCycleResult> {
    const startTime = Date.now();
    console.log('\n=== SCAN CYCLE START ===');
    console.log(new Date().toISOString());

    try {
      console.log('\n[1/6] Tracking odds...');
      const marketsTracked = await this.oddsTracker.trackAllMarkets();

      console.log('\n[2/6] Detecting odds changes (multi-timeframe)...');
      const oddsChanges = this.oddsTracker.detectMultiTimeframeChanges(
        this.config.polyOddsChangeThreshold
      );
      const timeframeMap = new Map<string, number>(
        oddsChanges.map(c => [c.market_condition_id, c.timeframesTriggered ?? 1])
      );

      console.log(`Found ${oddsChanges.length} significant odds changes`);

      console.log('\n[3/6] Scanning external catalysts...');
      const wave1Results = await Promise.allSettled([
        this.finvizScanner ? this.finvizScanner.scan() : Promise.resolve([] as SourceCatalyst[]),
        this.econCalendarScanner ? this.econCalendarScanner.scan() : Promise.resolve([] as SourceCatalyst[]),
        this.insiderScanner ? this.insiderScanner.scan() : Promise.resolve([] as SourceCatalyst[])
      ]);

      const getSettledCatalysts = (index: number, label: string) => {
        const result = wave1Results[index];
        if (!result) return [] as SourceCatalyst[];
        if (result.status === 'fulfilled') {
          return result.value;
        }
        console.warn(`[scan] ${label} failed: ${String(result.reason)}`);
        return [] as SourceCatalyst[];
      };

      const finvizCatalysts = getSettledCatalysts(0, 'FinViz');
      const econSurprises = getSettledCatalysts(1, 'econ');
      const insiderCatalysts = getSettledCatalysts(2, 'insider');
      const wave1AssetIds = [...new Set([
        ...finvizCatalysts.map(catalyst => catalyst.assetId),
        ...econSurprises.map(catalyst => catalyst.assetId),
        ...insiderCatalysts.map(catalyst => catalyst.assetId)
      ])];

      let technicalBreakouts: SourceCatalyst[] = [];
      if (this.technicalScanner) {
        try {
          technicalBreakouts = await this.technicalScanner.scan(wave1AssetIds);
        } catch (error) {
          console.warn(`[scan] technical failed: ${String(error)}`);
        }
      }

      const allCatalysts = [
        ...finvizCatalysts,
        ...technicalBreakouts,
        ...econSurprises,
        ...insiderCatalysts
      ];
      if (this.catalystEngine && allCatalysts.length > 0) {
        this.catalystEngine.ingestExternalCatalysts(allCatalysts);
      }
      console.log(
        `Captured ${allCatalysts.length} catalysts ` +
        `(FinViz ${finvizCatalysts.length}, technical ${technicalBreakouts.length}, ` +
        `econ ${econSurprises.length}, insider ${insiderCatalysts.length})`
      );

      console.log('\n[4/6] Detecting whale trades (top movers only)...');
      const changedMarketIds = [...new Set(oddsChanges.map(change => change.market_condition_id))];
      const whales = await this.whaleDetector.detectForMarkets(changedMarketIds, oddsChanges);

      console.log('\n[5/6] Generating signals (Polymarket + catalysts)...');
      const polySignals = await this.signalGenerator.generateSignals(oddsChanges);
      const catalystSignals = await this.signalGenerator.generateCatalystSignals(allCatalysts);
      const signals = [...polySignals, ...catalystSignals];

      if (this.db && signals.length > 0) {
        console.log('\n[6/6] Intelligence enrichment...');
        if (!this.intelligence) this.intelligence = new IntelligenceEngine(this.db);
        if (!this.newsCorrelator) this.newsCorrelator = new NewsCorrelator(this.db);
        if (!this.macroCalendar) this.macroCalendar = new MacroCalendar();
        this.catalystEngine?.backfillHistoricalSignals(45);
        this.sourceDiagnostics?.refreshIfStale();
        const intelligence = this.intelligence;
        const newsCorrelator = this.newsCorrelator;
        const macroCalendar = this.macroCalendar;
        const volContext = await this.volatilityRegimeDetector.getRegime();
        const volAdjustment = this.volatilityRegimeDetector.getConfidenceAdjustment(volContext.regime);
        await macroCalendar.refreshLiveEvents();
        intelligence.processNewSignals(signals);

        const pendingUpdates: Array<{ confidence: number; reasoning: string; id: string }> = [];

        for (const signal of signals) {
          let changed = false;

          // Multi-timeframe bonus: +5 for 2 windows, +10 for 3 windows
          const tframes = timeframeMap.get(signal.market_condition_id) ?? 1;
          if (tframes >= 3) {
            signal.confidence = Math.min(signal.confidence + 10, 92);
            signal.reasoning += ` [timeframes:${tframes}]`;
            changed = true;
            console.log(`  Multi-timeframe +10 for ${signal.matched_asset_name} (${tframes} windows) -> ${signal.confidence}%`);
          } else if (tframes >= 2) {
            signal.confidence = Math.min(signal.confidence + 5, 92);
            signal.reasoning += ` [timeframes:${tframes}]`;
            changed = true;
            console.log(`  Multi-timeframe +5 for ${signal.matched_asset_name} (${tframes} windows) -> ${signal.confidence}%`);
          }

          const boost = intelligence.getConfidenceBoost(signal.matched_asset_id);
          if (boost > 0) {
            signal.confidence = Math.min(signal.confidence + boost, 92);
            signal.reasoning += ` [intel:+${boost}]`;
            changed = true;
            console.log(`  Intelligence boost +${boost} for ${signal.matched_asset_name} -> ${signal.confidence}%`);
          }

          try {
            const perf = this.db.prepare(`
              SELECT suggested_confidence_adjustment, samples, reliability_score
              FROM asset_performance
              WHERE asset_id = ?
              LIMIT 1
            `).get(signal.matched_asset_id) as {
              suggested_confidence_adjustment: number;
              samples: number;
              reliability_score: number;
            } | undefined;

            if (perf && perf.samples >= 2 && perf.suggested_confidence_adjustment !== 0) {
              signal.confidence = Math.max(
                0,
                Math.min(signal.confidence + perf.suggested_confidence_adjustment, 92)
              );
              changed = true;
              console.log(
                `  Backtest adj ${perf.suggested_confidence_adjustment > 0 ? '+' : ''}${perf.suggested_confidence_adjustment} ` +
                `for ${signal.matched_asset_name} (samples=${perf.samples}, rel=${perf.reliability_score.toFixed(2)}) -> ${signal.confidence}%`
              );
            }
          } catch {
            // Ignore performance adjustment read issues.
          }

          // Hard ceiling — stacked boosts (intelligence + backtest) must never hit 100%
          signal.confidence = Math.min(signal.confidence, 92);

          // News correlator boost (deterministic, post-ceiling so it can push up to 92)
          const newsBoost = newsCorrelator.getBoostForAsset(signal.matched_asset_id);
          if (newsBoost.boost > 0) {
            signal.confidence = Math.min(signal.confidence + newsBoost.boost, 92);
            signal.reasoning += ` [news:+${newsBoost.boost} (${newsBoost.sourceCount} src)]`;
            changed = true;
            console.log(
              `  News boost +${newsBoost.boost} for ${signal.matched_asset_name} ` +
              `(${newsBoost.sourceCount} sources) -> ${signal.confidence}%`
            );
          }

          if (signal.signal_origin === 'polymarket' && allCatalysts.length > 0) {
            const signalDirection = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
            const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
            const confirming = allCatalysts.filter(catalyst => {
              const catalystTs = Date.parse(catalyst.timestamp);
              return catalyst.assetId === signal.matched_asset_id &&
                catalyst.directionHint === signalDirection &&
                Number.isFinite(catalystTs) &&
                catalystTs >= thirtyMinutesAgo;
            });

            if (confirming.length >= 2) {
              signal.confidence = Math.min(signal.confidence + 10, 92);
              signal.reasoning += ` [cross-source: ${confirming.length} external catalysts confirm]`;
              changed = true;
            } else if (confirming.length === 1) {
              signal.confidence = Math.min(signal.confidence + 5, 92);
              signal.reasoning += ' [cross-source: 1 external catalyst confirms]';
              changed = true;
            }
          }

          const macroContext = macroCalendar.isInEventWindow(signal.matched_asset_id);
          if (macroContext.inWindow) {
            signal.reasoning +=
              ` [macro: ${macroContext.eventName}, ${macroContext.minutesUntil}min away, impact:${macroContext.impact}]`;
            changed = true;

            if (macroContext.minutesUntil > 0 && macroContext.minutesUntil <= 30) {
              signal.confidence = Math.min(signal.confidence + 8, 92);
              console.log(
                `  Macro pre-drift +8 for ${signal.matched_asset_name} (${macroContext.eventName}, ${macroContext.minutesUntil}min) -> ${signal.confidence}%`
              );
            }
          }

          if (signal.confidence >= 50) {
            const futures = await this.futuresConfirmation.confirm(signal);
            if (futures) {
              const ret = futures.return5mPct >= 0
                ? `+${futures.return5mPct.toFixed(2)}%`
                : `${futures.return5mPct.toFixed(2)}%`;
              if (futures.alignment === 'confirms') {
                signal.confidence = Math.min(signal.confidence + futures.adjustment, 92);
                signal.reasoning += ` [futures: ${futures.symbol} confirms (${ret} / 5m)]`;
                changed = true;
              } else if (futures.alignment === 'contradicts') {
                signal.confidence = Math.max(0, Math.min(signal.confidence + futures.adjustment, 92));
                signal.reasoning += ` [futures: ${futures.symbol} CONTRADICTS (${ret} / 5m)]`;
                changed = true;
              } else {
                signal.reasoning += ` [futures: ${futures.symbol} flat (${ret} / 5m)]`;
                changed = true;
              }
            }
          }

          if (volAdjustment !== 0) {
            signal.confidence = Math.max(0, Math.min(signal.confidence + volAdjustment, 92));
            changed = true;
          }
          signal.reasoning += ` [vol:${volContext.regime}, VIX:${volContext.vix.toFixed(1)}]`;
          changed = true;

          if (changed) {
            pendingUpdates.push({ confidence: signal.confidence, reasoning: signal.reasoning, id: signal.id });
          }
        }

        if (pendingUpdates.length > 0) {
          try {
            const stmt = this.db.prepare('UPDATE signals SET confidence = ?, reasoning = ? WHERE id = ?');
            const batchUpdate = this.db.transaction((items: typeof pendingUpdates) => {
              for (const item of items) {
                stmt.run(item.confidence, item.reasoning, item.id);
              }
            });
            batchUpdate(pendingUpdates);
          } catch {
            // Non-fatal, continue scan cycle.
          }
        }

        if (this.catalystEngine && signals.length > 0) {
          this.catalystEngine.enrichSignals(signals, {
            newsCorrelator,
            macroCalendar
          });
        }
      }

      let dispatchSignals = signals;
      let fusionSummary: FusionGateSummary | null = null;
      if (
        this.db &&
        signals.length > 0 &&
        this.streamingStore &&
        this.fusionEngine
      ) {
        const fusionResult = this.applyFusionDecisions(signals);
        dispatchSignals = fusionResult.allowed;
        fusionSummary = fusionResult.summary;
        const topReasons = [...fusionSummary.suppressReasonCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([reason, count]) => `${reason} (${count})`)
          .join(', ');
        console.log(
          `  [fusion] total=${fusionSummary.total} allow=${fusionSummary.allow} ` +
          `fallback=${fusionSummary.fallbackPhase1} suppress=${fusionSummary.suppress} ` +
          `no_input=${fusionSummary.noInput}` +
          (topReasons ? ` | top_suppress=${topReasons}` : '')
        );
      }

      let haPushed = 0;
      let brewed = 0;
      if (dispatchSignals.length > 0) {
        console.log('\nDispatching alerts...');
        const dispatchResult = await this.alertDispatcher.dispatchBatch(dispatchSignals);
        haPushed = dispatchResult.pushedSwedish + dispatchResult.pushedUs;
        brewed = dispatchResult.brewed;
      } else if (signals.length > 0) {
        console.log(
          `\nDispatching alerts...\n  No push candidates after gating` +
          (fusionSummary ? ' (suppressed by fusion or threshold gates).' : '.')
        );
      }

      const duration = Date.now() - startTime;

      console.log('\n=== SCAN CYCLE COMPLETE ===');
      console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
      console.log(`Markets tracked: ${marketsTracked}`);
      console.log(`External catalysts: ${allCatalysts.length}`);
      console.log(`Whales detected: ${whales.length}`);
      console.log(`Odds changes: ${oddsChanges.length}`);
      console.log(`Signals generated: ${signals.length} (poly ${polySignals.length}, catalyst ${catalystSignals.length})`);
      console.log(`HA pushed: ${haPushed} | Brewed: ${brewed}`);

      return {
        marketsTracked,
        oddsChangesDetected: oddsChanges.length,
        whalesDetected: whales.length,
        signalsGenerated: signals.length,
        haPushed,
        brewed,
        duration
      };
    } catch (error) {
      console.error('Scan cycle failed:', error);
      throw error;
    }
  }

  private applyFusionDecisions(signals: any[]): { allowed: any[]; summary: FusionGateSummary } {
    const summary: FusionGateSummary = {
      total: signals.length,
      noInput: 0,
      allow: 0,
      suppress: 0,
      fallbackPhase1: 0,
      suppressReasonCounts: new Map()
    };

    if (!this.streamingStore || !this.fusionEngine) {
      summary.allow = signals.length;
      return { allowed: signals, summary };
    }
    if (!this.fusionOptions.enableFusionGating) {
      summary.allow = signals.length;
      return { allowed: signals, summary };
    }

    const allowed: any[] = [];

    for (const signal of signals) {
      const direction: TradeDirection = signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
      const inputs = this.streamingFeatureService?.getFusionInputsForAsset({
        signalId: signal.id,
        assetId: signal.matched_asset_id,
        assetName: signal.matched_asset_name,
        directionHint: direction,
        signalConfidence: signal.confidence,
        signalDeltaPct: signal.delta_pct,
        macroTag: this.extractReasonTag(signal.reasoning, 'macro'),
        futuresTag: this.extractReasonTag(signal.reasoning, 'futures'),
        volatilityTag: this.extractReasonTag(signal.reasoning, 'vol'),
        executionTag: this.extractReasonTag(signal.reasoning, 'execution'),
        secondVenueEnabled: this.fusionOptions.enableSecondVenue,
        liquidationEnabled: this.fusionOptions.enableLiquidations
      });

      if (!inputs) {
        summary.noInput += 1;
        summary.allow += 1;
        allowed.push(signal);
        continue;
      }

      const decision = this.fusionEngine.evaluate(inputs);
      this.streamingStore.insertFusionDecision(decision);
      signal.fusion_p_hat = decision.pHat;
      signal.fusion_expectancy_pct = decision.expectancyHatPct;
      signal.fusion_decision = decision.decision;
      signal.fusion_reasons = decision.reasons;
      signal.fusion_suppress_reasons = decision.suppressReasons;

      if (decision.decision === 'allow') {
        summary.allow += 1;
        signal.reasoning += ` [fusion:allow p=${decision.pHat.toFixed(2)} exp=${decision.expectancyHatPct.toFixed(2)}]`;
        const confidenceBoost = Math.round((decision.pHat - 0.5) * 20);
        if (confidenceBoost !== 0) {
          signal.confidence = Math.max(0, Math.min(signal.confidence + confidenceBoost, 92));
        }
        allowed.push(signal);
        this.persistSignalPostFusion(signal);
        continue;
      }

      if (decision.decision === 'fallback_phase1') {
        summary.fallbackPhase1 += 1;
        summary.allow += 1;
        signal.reasoning += ' [fusion:fallback_phase1]';
        allowed.push(signal);
        this.persistSignalPostFusion(signal);
        continue;
      }

      summary.suppress += 1;
      for (const reason of decision.suppressReasons || []) {
        summary.suppressReasonCounts.set(reason, (summary.suppressReasonCounts.get(reason) || 0) + 1);
      }
      signal.reasoning += ` [fusion:suppress p=${decision.pHat.toFixed(2)} exp=${decision.expectancyHatPct.toFixed(2)}]`;
      this.persistSignalPostFusion(signal);
      if (this.fusionOptions.enableSuppressedDecisionStorage) {
        this.streamingStore.insertSuppressedDecision(decision);
      }
    }

    return { allowed, summary };
  }

  private persistSignalPostFusion(signal: any): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        UPDATE signals
        SET confidence = ?, reasoning = ?
        WHERE id = ?
      `).run(signal.confidence, signal.reasoning, signal.id);
    } catch {
      // Non-fatal.
    }
  }

  private extractReasonTag(reasoning: string, tag: string): string | undefined {
    const regex = new RegExp(`\\[${tag}:[^\\]]+\\]`, 'i');
    const found = (reasoning || '').match(regex);
    return found?.[0];
  }
}
