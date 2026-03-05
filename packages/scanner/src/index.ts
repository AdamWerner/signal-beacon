import cron from 'node-cron';
import { loadConfig, validateConfig } from './config.js';
import { initializeDatabase } from './storage/db.js';
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
import { logger } from './utils/logger.js';
import { TweetStore } from './storage/tweet-store.js';
import { TweetCollector } from './tweets/collector.js';
import { TweetIntelligenceProcessor } from './tweets/processor.js';

export class PolySignalScanner {
  private config = loadConfig();
  private db = initializeDatabase();

  private instrumentStore = new InstrumentStore(this.db);
  private marketStore = new MarketStore(this.db);
  private snapshotStore = new SnapshotStore(this.db);
  private signalStore = new SignalStore(this.db);
  private whaleStore = new WhaleStore(this.db);
  private tweetStore = new TweetStore(this.db);
  private tweetCollector: TweetCollector;
  private tweetProcessor: TweetIntelligenceProcessor;

  private ontology = new OntologyEngine();
  private avanzaClient: ReturnType<typeof createAvanzaClient> | null = null;
  private avanzaAvailable = false;
  private instrumentRegistry: InstrumentRegistry | null = null;
  private avanzaScraper: AvanzaScraper | null = null;
  private polymarketClient = new PolymarketClient();
  private marketDiscoverer: MarketDiscoverer;
  private oddsTracker: OddsTracker;
  private whaleDetector: WhaleDetector;
  private autoMapper: AutoMapper;
  private signalGenerator: SignalGenerator;
  private alertDispatcher: AlertDispatcher;

  private scanCycleJob: ScanCycleJob;
  private marketRefreshJob: MarketRefreshJob;
  private instrumentRefreshJob: InstrumentRefreshJob | null = null;
  private cleanupJob: CleanupJob;

  constructor() {
    validateConfig(this.config);

    if (process.env.AVANZA_USERNAME) {
      console.log('Avanza credentials found, attempting connection...');
      try {
        this.avanzaClient = createAvanzaClient();
        this.avanzaAvailable = true;
        this.instrumentRegistry = new InstrumentRegistry(this.instrumentStore, this.avanzaClient);
        this.avanzaScraper = new AvanzaScraper(this.instrumentRegistry, this.ontology);
        console.log('Avanza client created successfully (auth is lazy - happens on first instrument search)');
      } catch (err) {
        console.error('Avanza setup failed - instrument discovery disabled:', err);
        logger.warn('Avanza authentication setup failed - instrument discovery disabled', {
          error: String(err)
        });
      }
    } else {
      logger.info(
        'Running without Avanza credentials - instrument discovery disabled, using ontology-based suggestions'
      );
    }

    this.marketDiscoverer = new MarketDiscoverer(
      this.polymarketClient,
      this.ontology,
      this.marketStore,
      this.config.polyMarketRelevanceThreshold
    );

    this.oddsTracker = new OddsTracker(this.polymarketClient, this.snapshotStore, this.marketStore);
    this.whaleDetector = new WhaleDetector(
      this.polymarketClient,
      this.whaleStore,
      this.marketStore,
      this.config.polyWhaleThresholdUsd
    );

    this.autoMapper = new AutoMapper(this.ontology, this.instrumentRegistry);
    this.signalGenerator = new SignalGenerator(
      this.autoMapper,
      this.marketStore,
      this.whaleDetector,
      this.signalStore
    );

    this.alertDispatcher = new AlertDispatcher({
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
        : undefined,
      homeAssistant: this.config.haUrl && this.config.haToken
        ? {
            url: this.config.haUrl,
            token: this.config.haToken,
            notifyService: this.config.haNotifyService,
            minConfidence: this.config.alertMinConfidenceHa,
            enabled: true
          }
        : undefined
    });

    this.scanCycleJob = new ScanCycleJob(
      this.config,
      this.oddsTracker,
      this.whaleDetector,
      this.signalGenerator,
      this.alertDispatcher,
      this.db
    );

    this.marketRefreshJob = new MarketRefreshJob(this.marketDiscoverer);
    if (this.avanzaScraper) {
      this.instrumentRefreshJob = new InstrumentRefreshJob(this.avanzaScraper);
    }

    this.cleanupJob = new CleanupJob(
      this.snapshotStore,
      this.signalStore,
      this.whaleStore,
      this.marketDiscoverer,
      this.tweetStore
    );

    this.tweetCollector = new TweetCollector(this.tweetStore);
    this.tweetProcessor = new TweetIntelligenceProcessor(this.db);

    const seedResult = this.tweetStore.seedDefaultAccounts(1200);
    console.log(
      `Tweet universe ready: ${seedResult.currentCount} accounts ` +
      `(seed +${seedResult.insertedFromSeed}, graph +${seedResult.discoveredFromConnections}, collect_set=${seedResult.collectionSetSize})`
    );

    logger.info('PolySignal Scanner initialized', {
      environment: this.config.nodeEnv,
      avanza: this.avanzaAvailable ? 'connected' : 'unavailable'
    });
  }

  start() {
    logger.info('Starting PolySignal Scanner');

    cron.schedule(this.config.jobScanCron, async () => {
      try {
        await this.scanCycleJob.execute();
      } catch (error) {
        logger.error('Scan cycle error', { error: String(error) });
      }
    });
    logger.info('Scan cycle scheduled', { cron: this.config.jobScanCron });

    cron.schedule(this.config.jobMarketRefreshCron, async () => {
      try {
        await this.marketRefreshJob.execute();
      } catch (error) {
        logger.error('Market refresh error', { error: String(error) });
      }
    });
    logger.info('Market refresh scheduled', { cron: this.config.jobMarketRefreshCron });

    if (this.instrumentRefreshJob) {
      const instrumentRefreshJob = this.instrumentRefreshJob;

      cron.schedule(this.config.jobInstrumentRefreshCron, async () => {
        try {
          await instrumentRefreshJob.execute();
        } catch (error) {
          logger.error('Instrument refresh error', { error: String(error) });
        }
      });
      logger.info('Instrument refresh scheduled', { cron: this.config.jobInstrumentRefreshCron });

      setImmediate(async () => {
        try {
          console.log('Running startup instrument refresh...');
          await instrumentRefreshJob.execute();
          console.log('Startup instrument refresh complete');
        } catch (err) {
          console.error('Startup instrument refresh failed:', err);
        }
      });
    } else {
      logger.warn('Instrument refresh disabled (Avanza unavailable)');
    }

    cron.schedule(this.config.jobCleanupCron, async () => {
      try {
        await this.cleanupJob.execute();
      } catch (error) {
        logger.error('Cleanup error', { error: String(error) });
      }
    });
    logger.info('Cleanup scheduled', { cron: this.config.jobCleanupCron });

    logger.info('Scanner is running');
  }

  async runScanCycle() {
    return await this.scanCycleJob.execute();
  }

  async runMarketRefresh() {
    return await this.marketRefreshJob.execute();
  }

  async runInstrumentRefresh() {
    if (!this.instrumentRefreshJob) {
      throw new Error('Instrument refresh unavailable: Avanza credentials not configured');
    }
    return await this.instrumentRefreshJob.execute();
  }

  async runCleanup() {
    return await this.cleanupJob.execute();
  }

  getAvanzaAvailable(): boolean {
    return this.avanzaAvailable;
  }

  async runTweetCollection() {
    const collected = await this.tweetCollector.collectAll(120);
    const discovered = this.tweetStore.discoverConnectionsFromRecentTweets(48, 300);
    const collectionSetSize = this.tweetStore.rebalanceCollectionSet(140);

    return {
      ...collected,
      accountsAdded: collected.accountsAdded + discovered.accountsAdded,
      connectionsAdded: collected.connectionsAdded + discovered.connectionsAdded,
      collectionSetSize,
      universeCount: this.tweetStore.getAccountCount()
    };
  }

  async runTweetProcessing() {
    return await this.tweetProcessor.processTweetBatch();
  }

  runTweetUniverseExpansion(target = 1200) {
    return this.tweetStore.expandUniverseToTarget(target);
  }

  getTweetContextForBriefing(hours = 16): string {
    return this.tweetProcessor.getTweetContextForBriefing(hours);
  }

  getServices() {
    return {
      instrumentStore: this.instrumentStore,
      marketStore: this.marketStore,
      snapshotStore: this.snapshotStore,
      signalStore: this.signalStore,
      whaleStore: this.whaleStore,
      tweetStore: this.tweetStore,
      ontology: this.ontology,
      instrumentRegistry: this.instrumentRegistry,
      marketDiscoverer: this.marketDiscoverer,
      avanzaAvailable: this.avanzaAvailable,
      db: this.db as any
    };
  }
}

export { AutoMapper } from './correlation/auto-mapper.js';
export { getTopSignals, analyzeSignal } from './signals/ai-ranker.js';
export { IntelligenceEngine } from './intelligence/engine.js';
export { TweetStore } from './storage/tweet-store.js';
export { TweetCollector } from './tweets/collector.js';
export { TweetIntelligenceProcessor } from './tweets/processor.js';

export const scanner = new PolySignalScanner();

if (import.meta.url === `file://${process.argv[1]}`) {
  scanner.start();
}

