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
  alertsSent: number;
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
   * Execute one scan cycle
   */
  async execute(): Promise<ScanCycleResult> {
    const startTime = Date.now();
    console.log('\n=== SCAN CYCLE START ===');
    console.log(new Date().toISOString());

    try {
      // Step 1: Track current odds for all markets
      console.log('\n[1/4] Tracking odds...');
      const marketsTracked = await this.oddsTracker.trackAllMarkets();

      // Step 2: Detect significant odds changes
      console.log('\n[2/4] Detecting odds changes...');
      const oddsChanges = this.oddsTracker.detectSignificantChanges(
        this.config.polyTimeWindowMinutes,
        this.config.polyOddsChangeThreshold
      );

      console.log(`Found ${oddsChanges.length} significant odds changes`);

      // Step 3: Detect whale activity — only on markets that had odds changes
      console.log('\n[3/4] Detecting whale trades (changed markets only)...');
      const changedMarketIds = [...new Set(oddsChanges.map(c => c.market_condition_id))];
      const whales = await this.whaleDetector.detectForMarkets(changedMarketIds);

      // Step 4: Generate signals
      console.log('\n[4/4] Generating signals...');
      const signals = await this.signalGenerator.generateSignals(oddsChanges);

      // Step 5: Process through intelligence layer (accumulate context, boost confidence)
      if (this.db && signals.length > 0) {
        const intel = new IntelligenceEngine(this.db);
        intel.processNewSignals(signals);
        for (const signal of signals) {
          const boost = intel.getConfidenceBoost(signal.matched_asset_id);
          if (boost > 0) {
            signal.confidence = Math.min(signal.confidence + boost, 100);
          }
        }
      }

      // Step 6: Dispatch alerts
      if (signals.length > 0) {
        console.log('\nDispatching alerts...');
        await this.alertDispatcher.dispatchBatch(signals);
      }

      const duration = Date.now() - startTime;

      console.log('\n=== SCAN CYCLE COMPLETE ===');
      console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
      console.log(`Markets tracked: ${marketsTracked}`);
      console.log(`Whales detected: ${whales.length}`);
      console.log(`Odds changes: ${oddsChanges.length}`);
      console.log(`Signals generated: ${signals.length}`);

      return {
        marketsTracked,
        oddsChangesDetected: oddsChanges.length,
        whalesDetected: whales.length,
        signalsGenerated: signals.length,
        alertsSent: signals.filter(s => s.confidence >= this.config.alertMinConfidence).length,
        duration
      };
    } catch (error) {
      console.error('Scan cycle failed:', error);
      throw error;
    }
  }
}
