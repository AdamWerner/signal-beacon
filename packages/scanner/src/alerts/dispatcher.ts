import { PushoverClient } from './pushover.js';
import { WebhookClient } from './webhook.js';
import { HomeAssistantAlert } from './homeassistant.js';
import { AlertConfig } from './types.js';
import { GeneratedSignal } from '../signals/types.js';
import { shouldPushSignal, getAssetMarket } from '../intelligence/trading-hours.js';

export class AlertDispatcher {
  private pushover?: PushoverClient;
  private webhook?: WebhookClient;
  private homeAssistant?: HomeAssistantAlert;
  private haMinConfidence: number;
  private minConfidence: number;

  constructor(config: AlertConfig) {
    this.minConfidence = config.minConfidence || 50;
    this.haMinConfidence = config.homeAssistant?.minConfidence ?? 65;

    if (config.pushover) {
      this.pushover = new PushoverClient(config.pushover);
    }

    if (config.webhook) {
      this.webhook = new WebhookClient(config.webhook);
    }

    if (config.homeAssistant?.enabled && config.homeAssistant.url && config.homeAssistant.token) {
      this.homeAssistant = new HomeAssistantAlert(
        config.homeAssistant.url,
        config.homeAssistant.token,
        config.homeAssistant.notifyService
      );
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

    if (this.homeAssistant && !signal.requires_judgment) {
      const meetsThreshold = signal.confidence >= this.haMinConfidence && Math.abs(signal.delta_pct) >= 20;
      const pushNow = meetsThreshold && shouldPushSignal(signal.matched_asset_id, signal.confidence);
      const exceptionalSignal = meetsThreshold && signal.confidence >= 80;  // Always push very high confidence

      if (pushNow || exceptionalSignal) {
        promises.push(this.homeAssistant.send(signal));
      } else if (meetsThreshold) {
        const market = getAssetMarket(signal.matched_asset_id);
        console.log(`  ☕ Signal ${signal.id} brewing — ${market} market closed, will appear in morning briefing`);
      }
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
