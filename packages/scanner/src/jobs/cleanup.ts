import { SnapshotStore } from '../storage/snapshot-store.js';
import { SignalStore } from '../storage/signal-store.js';
import { WhaleStore } from '../storage/whale-store.js';

export interface CleanupResult {
  snapshotsDeleted: number;
  signalsDeleted: number;
  whalesDeleted: number;
  duration: number;
}

export class CleanupJob {
  constructor(
    private snapshotStore: SnapshotStore,
    private signalStore: SignalStore,
    private whaleStore: WhaleStore
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

      // Keep 90 days of signals (except acted ones)
      console.log('Cleaning up old signals...');
      const signalsDeleted = this.signalStore.cleanupOld(90);
      console.log(`  Deleted ${signalsDeleted} old signals`);

      // Keep 30 days of whale events
      console.log('Cleaning up old whale events...');
      const whalesDeleted = this.whaleStore.cleanupOld(30);
      console.log(`  Deleted ${whalesDeleted} old whale events`);

      const duration = Date.now() - startTime;

      console.log('\n=== CLEANUP JOB COMPLETE ===');
      console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);

      return {
        snapshotsDeleted,
        signalsDeleted,
        whalesDeleted,
        duration
      };
    } catch (error) {
      console.error('Cleanup job failed:', error);
      throw error;
    }
  }
}
