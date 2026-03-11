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

export interface ScanCycleResult {
  marketsTracked: number;
  oddsChangesDetected: number;
  whalesDetected: number;
  signalsGenerated: number;
  haPushed: number;
  brewed: number;
  duration: number;
}

export class ScanCycleJob {
  private volatilityRegimeDetector = new VolatilityRegimeDetector();
  private futuresConfirmation = new FuturesConfirmationService();

  constructor(
    private config: Config,
    private oddsTracker: OddsTracker,
    private whaleDetector: WhaleDetector,
    private signalGenerator: SignalGenerator,
    private alertDispatcher: AlertDispatcher,
    private db?: Database.Database
  ) {}

  /**
   * Execute one scan cycle.
   */
  async execute(): Promise<ScanCycleResult> {
    const startTime = Date.now();
    console.log('\n=== SCAN CYCLE START ===');
    console.log(new Date().toISOString());

    try {
      console.log('\n[1/4] Tracking odds...');
      const marketsTracked = await this.oddsTracker.trackAllMarkets();

      console.log('\n[2/4] Detecting odds changes (multi-timeframe)...');
      const oddsChanges = this.oddsTracker.detectMultiTimeframeChanges(
        this.config.polyOddsChangeThreshold
      );
      const timeframeMap = new Map<string, number>(
        oddsChanges.map(c => [c.market_condition_id, c.timeframesTriggered ?? 1])
      );

      console.log(`Found ${oddsChanges.length} significant odds changes`);

      console.log('\n[3/4] Detecting whale trades (top movers only)...');
      const changedMarketIds = [...new Set(oddsChanges.map(change => change.market_condition_id))];
      const whales = await this.whaleDetector.detectForMarkets(changedMarketIds, oddsChanges);

      console.log('\n[4/4] Generating signals...');
      const signals = await this.signalGenerator.generateSignals(oddsChanges);

      if (this.db && signals.length > 0) {
        const intelligence = new IntelligenceEngine(this.db);
        const newsCorrelator = new NewsCorrelator(this.db);
        const macroCalendar = new MacroCalendar();
        const volContext = await this.volatilityRegimeDetector.getRegime();
        const volAdjustment = this.volatilityRegimeDetector.getConfidenceAdjustment(volContext.regime);
        await macroCalendar.refreshLiveEvents();
        intelligence.processNewSignals(signals);

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
            try {
              this.db.prepare('UPDATE signals SET confidence = ? WHERE id = ?').run(signal.confidence, signal.id);
            } catch {
              // Non-fatal, continue scan cycle.
            }
          }
        }
      }

      let haPushed = 0;
      let brewed = 0;
      if (signals.length > 0) {
        console.log('\nDispatching alerts...');
        const dispatchResult = await this.alertDispatcher.dispatchBatch(signals);
        haPushed = dispatchResult.pushedSwedish + dispatchResult.pushedUs;
        brewed = dispatchResult.brewed;
      }

      const duration = Date.now() - startTime;

      console.log('\n=== SCAN CYCLE COMPLETE ===');
      console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
      console.log(`Markets tracked: ${marketsTracked}`);
      console.log(`Whales detected: ${whales.length}`);
      console.log(`Odds changes: ${oddsChanges.length}`);
      console.log(`Signals generated: ${signals.length}`);
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
}
