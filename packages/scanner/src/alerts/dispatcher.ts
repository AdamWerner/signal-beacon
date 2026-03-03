import { PushoverClient } from './pushover.js';
import { WebhookClient } from './webhook.js';
import { AlertConfig } from './types.js';
import { GeneratedSignal } from '../signals/types.js';

export class AlertDispatcher {
  private pushover?: PushoverClient;
  private webhook?: WebhookClient;
  private minConfidence: number;

  constructor(config: AlertConfig) {
    this.minConfidence = config.minConfidence || 50;

    if (config.pushover) {
      this.pushover = new PushoverClient(config.pushover);
    }

    if (config.webhook) {
      this.webhook = new WebhookClient(config.webhook);
    }
  }

  /**
   * Dispatch alerts for a signal
   */
  async dispatch(signal: GeneratedSignal): Promise<void> {
    // Only send alerts for signals above confidence threshold
    if (signal.confidence < this.minConfidence) {
      console.log(`Signal ${signal.id} below confidence threshold (${signal.confidence}% < ${this.minConfidence}%)`);
      return;
    }

    console.log(`Dispatching alerts for signal ${signal.id} (confidence: ${signal.confidence}%)`);

    const promises: Promise<boolean>[] = [];

    if (this.pushover) {
      promises.push(this.pushover.send(signal));
    }

    if (this.webhook) {
      promises.push(this.webhook.send(signal));
    }

    await Promise.all(promises);
  }

  /**
   * Dispatch alerts for multiple signals
   */
  async dispatchBatch(signals: GeneratedSignal[]): Promise<void> {
    for (const signal of signals) {
      await this.dispatch(signal);
    }
  }
}
