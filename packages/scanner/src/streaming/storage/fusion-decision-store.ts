import { StreamingStore } from './streaming-store.js';
import { FusionDecision } from '../fusion/types.js';

export class FusionDecisionStore {
  constructor(private streamingStore: StreamingStore) {}

  insertDecision(decision: FusionDecision): void {
    this.streamingStore.insertFusionDecision(decision);
  }

  insertSuppressed(decision: FusionDecision): void {
    this.streamingStore.insertSuppressedDecision(decision);
  }

  latest(limit = 100) {
    return this.streamingStore.getFusionDecisions(limit);
  }

  latestSuppressed(limit = 100) {
    return this.streamingStore.getSuppressedDecisions(limit);
  }
}

