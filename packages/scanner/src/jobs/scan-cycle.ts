import Database from 'better-sqlite3';
import { Config } from '../config.js';
import { OddsTracker } from '../polymarket/odds-tracker.js';
import { WhaleDetector } from '../polymarket/whale-detector.js';
import { SignalGenerator } from '../signals/generator.js';
import { AlertDispatcher } from '../alerts/dispatcher.js';
import { IntelligenceEngine } from '../intelligence/engine.js';

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

      console.log('\n[2/4] Detecting odds changes...');
      const oddsChanges = this.oddsTracker.detectSignificantChanges(
        this.config.polyTimeWindowMinutes,
        this.config.polyOddsChangeThreshold
      );

      console.log(`Found ${oddsChanges.length} significant odds changes`);

      console.log('\n[3/4] Detecting whale trades (top movers only)...');
      const changedMarketIds = [...new Set(oddsChanges.map(change => change.market_condition_id))];
      const whales = await this.whaleDetector.detectForMarkets(changedMarketIds, oddsChanges);

      console.log('\n[4/4] Generating signals...');
      const signals = await this.signalGenerator.generateSignals(oddsChanges);

      if (this.db && signals.length > 0) {
        const intelligence = new IntelligenceEngine(this.db);
        intelligence.processNewSignals(signals);

        for (const signal of signals) {
          const boost = intelligence.getConfidenceBoost(signal.matched_asset_id);
          if (boost <= 0) continue;

          signal.confidence = Math.min(signal.confidence + boost, 100);

          // Persist boosted confidence so the DB, API, and notifications stay consistent.
          try {
            this.db.prepare('UPDATE signals SET confidence = ? WHERE id = ?').run(signal.confidence, signal.id);
            console.log(`  Intelligence boost +${boost} for ${signal.matched_asset_name} -> ${signal.confidence}%`);
          } catch {
            // Non-fatal, continue scan cycle.
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
