import cron from 'node-cron';
import { loadConfig, validateConfig } from './config.js';
import { initializeDatabase, getDatabase } from './storage/db.js';
import { InstrumentStore } from './storage/instrument-store.js';
import { MarketStore } from './storage/market-store.js';
import { SnapshotStore } from './storage/snapshot-store.js';
import { SignalStore } from './storage/signal-store.js';
import { WhaleStore } from './storage/whale-store.js';
import { OntologyEngine } from './correlation/ontology.js';
import { createAvanzaClient } from './avanza/search-client.js';
import { InstrumentRegistry } from './avanza/instrument-registry.js';
import { AvanzaScraper } from './avanza/scraper.js';
import { PolymarketClient } from './polymarket/client.js';
import { MarketDiscoverer } from './polymarket/market-discoverer.js';
import { OddsTracker } from './polymarket/odds-tracker.js';
import { WhaleDetector } from './polymarket/whale-detector.js';
import { AutoMapper } from './correlation/auto-mapper.js';
import { SignalGenerator } from './signals/generator.js';
import { AlertDispatcher } from './alerts/dispatcher.js';
import { ScanCycleJob } from './jobs/scan-cycle.js';
import { MarketRefreshJob } from './jobs/market-refresh.js';
import { InstrumentRefreshJob } from './jobs/instrument-refresh.js';
import { CleanupJob } from './jobs/cleanup.js';

export class PolySignalScanner {
  private config = loadConfig();
  private db = initializeDatabase();

  // Stores
  private instrumentStore = new InstrumentStore(this.db);
  private marketStore = new MarketStore(this.db);
  private snapshotStore = new SnapshotStore(this.db);
  private signalStore = new SignalStore(this.db);
  private whaleStore = new WhaleStore(this.db);

  // Core services
  private ontology = new OntologyEngine();
  private avanzaClient = createAvanzaClient();
  private instrumentRegistry = new InstrumentRegistry(this.instrumentStore, this.avanzaClient);
  private avanzaScraper = new AvanzaScraper(this.instrumentRegistry, this.ontology);
  private polymarketClient = new PolymarketClient();
  private marketDiscoverer = new MarketDiscoverer(
    this.polymarketClient,
    this.ontology,
    this.marketStore,
    this.config.polyMarketRelevanceThreshold
  );
  private oddsTracker = new OddsTracker(this.polymarketClient, this.snapshotStore, this.marketStore);
  private whaleDetector = new WhaleDetector(
    this.polymarketClient,
    this.whaleStore,
    this.marketStore,
    this.config.polyWhaleThresholdUsd
  );
  private autoMapper = new AutoMapper(this.ontology, this.instrumentRegistry);
  private signalGenerator = new SignalGenerator(
    this.autoMapper,
    this.marketStore,
    this.whaleDetector,
    this.signalStore
  );
  private alertDispatcher = new AlertDispatcher({
    minConfidence: this.config.alertMinConfidence,
    pushover: this.config.alertPushoverUserKey && this.config.alertPushoverAppToken
      ? {
          userKey: this.config.alertPushoverUserKey,
          appToken: this.config.alertPushoverAppToken,
          enabled: true
        }
      : undefined,
    webhook: this.config.alertWebhookUrl
      ? {
          url: this.config.alertWebhookUrl,
          enabled: true
        }
      : undefined
  });

  // Jobs
  private scanCycleJob = new ScanCycleJob(
    this.config,
    this.oddsTracker,
    this.whaleDetector,
    this.signalGenerator,
    this.alertDispatcher
  );
  private marketRefreshJob = new MarketRefreshJob(this.marketDiscoverer);
  private instrumentRefreshJob = new InstrumentRefreshJob(this.avanzaScraper);
  private cleanupJob = new CleanupJob(this.snapshotStore, this.signalStore, this.whaleStore);

  constructor() {
    validateConfig(this.config);
    console.log('PolySignal Scanner initialized');
    console.log(`Environment: ${this.config.nodeEnv}`);
  }

  /**
   * Start the scanner with scheduled jobs
   */
  start() {
    console.log('\n=== STARTING POLYSIGNAL SCANNER ===\n');

    // Scan cycle: Every 15 minutes (default)
    cron.schedule(this.config.jobScanCron, async () => {
      try {
        await this.scanCycleJob.execute();
      } catch (error) {
        console.error('Scan cycle error:', error);
      }
    });
    console.log(`✓ Scan cycle scheduled: ${this.config.jobScanCron}`);

    // Market refresh: Every 6 hours (default)
    cron.schedule(this.config.jobMarketRefreshCron, async () => {
      try {
        await this.marketRefreshJob.execute();
      } catch (error) {
        console.error('Market refresh error:', error);
      }
    });
    console.log(`✓ Market refresh scheduled: ${this.config.jobMarketRefreshCron}`);

    // Instrument refresh: Daily at 6 AM (default)
    cron.schedule(this.config.jobInstrumentRefreshCron, async () => {
      try {
        await this.instrumentRefreshJob.execute();
      } catch (error) {
        console.error('Instrument refresh error:', error);
      }
    });
    console.log(`✓ Instrument refresh scheduled: ${this.config.jobInstrumentRefreshCron}`);

    // Cleanup: Daily at 3 AM (default)
    cron.schedule(this.config.jobCleanupCron, async () => {
      try {
        await this.cleanupJob.execute();
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    });
    console.log(`✓ Cleanup scheduled: ${this.config.jobCleanupCron}`);

    console.log('\nScanner is running. Press Ctrl+C to stop.\n');
  }

  /**
   * Run a single scan cycle manually
   */
  async runScanCycle() {
    return await this.scanCycleJob.execute();
  }

  /**
   * Run market refresh manually
   */
  async runMarketRefresh() {
    return await this.marketRefreshJob.execute();
  }

  /**
   * Run instrument refresh manually
   */
  async runInstrumentRefresh() {
    return await this.instrumentRefreshJob.execute();
  }

  /**
   * Run cleanup manually
   */
  async runCleanup() {
    return await this.cleanupJob.execute();
  }

  /**
   * Get all services (for API access)
   */
  getServices() {
    return {
      instrumentStore: this.instrumentStore,
      marketStore: this.marketStore,
      snapshotStore: this.snapshotStore,
      signalStore: this.signalStore,
      whaleStore: this.whaleStore,
      ontology: this.ontology,
      instrumentRegistry: this.instrumentRegistry,
      marketDiscoverer: this.marketDiscoverer
    };
  }
}

// Export singleton instance
export const scanner = new PolySignalScanner();

// Start scanner if running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  scanner.start();
}
