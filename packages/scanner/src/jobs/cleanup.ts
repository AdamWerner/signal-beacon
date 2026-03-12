import Database from 'better-sqlite3';
import { SnapshotStore } from '../storage/snapshot-store.js';
import { SignalStore } from '../storage/signal-store.js';
import { WhaleStore } from '../storage/whale-store.js';
import { MarketDiscoverer } from '../polymarket/market-discoverer.js';
import { TweetStore } from '../storage/tweet-store.js';

export interface CleanupResult {
  snapshotsDeleted: number;
  signalsExpired: number;
  signalsDeleted: number;
  whalesDeleted: number;
  marketsResolved: number;
  tweetsDeleted: number;
  streamingRowsDeleted: number;
  duration: number;
}

export class CleanupJob {
  constructor(
    private snapshotStore: SnapshotStore,
    private signalStore: SignalStore,
    private whaleStore: WhaleStore,
    private marketDiscoverer: MarketDiscoverer,
    private tweetStore?: TweetStore,
    private db?: Database.Database
  ) {}

  /**
   * Clean up old data
   */
  async execute(): Promise<CleanupResult> {
    const startTime = Date.now();
    console.log('\n=== CLEANUP JOB START ===');
    console.log(new Date().toISOString());

    try {
      // Keep 30 days of snapshots
      console.log('Cleaning up old snapshots...');
      const snapshotsDeleted = this.snapshotStore.cleanupOld(30);
      console.log(`  Deleted ${snapshotsDeleted} old snapshots`);

      // Auto-expire signals still 'new' after 48 hours
      console.log('Expiring stale signals...');
      const signalsExpired = this.signalStore.expireStale(48);
      console.log(`  Expired ${signalsExpired} stale signals`);

      // Keep 90 days of signals (except acted ones)
      console.log('Cleaning up old signals...');
      const signalsDeleted = this.signalStore.cleanupOld(90);
      console.log(`  Deleted ${signalsDeleted} old signals`);

      // Keep 30 days of whale events
      console.log('Cleaning up old whale events...');
      const whalesDeleted = this.whaleStore.cleanupOld(30);
      console.log(`  Deleted ${whalesDeleted} old whale events`);

      // Remove orphan whale events (market deleted by noise filter or resolution)
      console.log('Cleaning up orphan whale events...');
      const whaleOrphans = this.whaleStore.cleanupOrphans();
      console.log(`  Removed ${whaleOrphans} orphan whale events`);

      // Soft-delete noise markets tracked before filters were tightened
      console.log('Cleaning up noise markets...');
      const noiseRemoved = this.marketDiscoverer.cleanupNoiseMarkets();
      console.log(`  Removed ${noiseRemoved} noise markets`);

      // Dismiss signals from markets that are now inactive (resolved or noise-cleaned)
      console.log('Dismissing signals from inactive markets...');
      const dismissedNoise = this.signalStore.dismissFromInactiveMarkets();
      console.log(`  Dismissed ${dismissedNoise} signals from inactive markets`);

      // Check for resolved markets (daily, not per-scan)
      console.log('Checking for resolved markets...');
      const marketsResolved = await this.marketDiscoverer.markResolvedMarkets();
      console.log(`  Marked ${marketsResolved} markets as resolved`);

      // Clean up old tweets (keep 7 days)
      let tweetsDeleted = 0;
      let streamingRowsDeleted = 0;
      if (this.tweetStore) {
        console.log('Cleaning up old tweets...');
        tweetsDeleted = this.tweetStore.cleanupOld(7);
        console.log(`  Deleted ${tweetsDeleted} old tweets`);

        if (this.db) {
          const legacyDeleted = this.db.prepare(`
            DELETE FROM tweet_accounts
            WHERE feed_url IS NULL
              AND discovery_source IN ('dataset', 'graph')
              AND handle NOT IN (SELECT DISTINCT account_handle FROM tweet_snapshots)
          `).run().changes;
          if (legacyDeleted > 0) {
            console.log(`  Removed ${legacyDeleted} legacy tweet handles without feed URLs`);
          }
        }
      }

      // Force WAL checkpoint to prevent unbounded WAL growth (runs daily)
      if (this.db) {
        try {
          streamingRowsDeleted += this.db.prepare(`
            DELETE FROM feature_snapshots_1s
            WHERE timestamp < datetime('now', '-3 days')
          `).run().changes;
          streamingRowsDeleted += this.db.prepare(`
            DELETE FROM feature_snapshots_1m
            WHERE timestamp < datetime('now', '-14 days')
          `).run().changes;
          streamingRowsDeleted += this.db.prepare(`
            DELETE FROM liquidity_events
            WHERE timestamp < datetime('now', '-14 days')
          `).run().changes;
          streamingRowsDeleted += this.db.prepare(`
            DELETE FROM liquidation_events
            WHERE timestamp < datetime('now', '-14 days')
          `).run().changes;
          streamingRowsDeleted += this.db.prepare(`
            DELETE FROM leader_lag_snapshots
            WHERE timestamp < datetime('now', '-14 days')
          `).run().changes;
          streamingRowsDeleted += this.db.prepare(`
            DELETE FROM fusion_decisions
            WHERE timestamp < datetime('now', '-30 days')
          `).run().changes;
          streamingRowsDeleted += this.db.prepare(`
            DELETE FROM suppressed_decisions
            WHERE timestamp < datetime('now', '-30 days')
          `).run().changes;
        } catch {
          // Streaming tables may not exist in older schemas.
        }

        if (streamingRowsDeleted > 0) {
          console.log(`  Deleted ${streamingRowsDeleted} streaming/fusion rows`);
        }

        try {
          this.db.pragma('wal_checkpoint(TRUNCATE)');
          console.log('  WAL checkpoint completed');
        } catch {
          // Non-fatal — checkpoint will retry next cleanup cycle.
        }
      }

      const duration = Date.now() - startTime;

      console.log('\n=== CLEANUP JOB COMPLETE ===');
      console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);

      return {
        snapshotsDeleted,
        signalsExpired,
        signalsDeleted,
        whalesDeleted,
        marketsResolved,
        tweetsDeleted,
        streamingRowsDeleted,
        duration
      };
    } catch (error) {
      console.error('Cleanup job failed:', error);
      throw error;
    }
  }
}
