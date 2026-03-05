import { PushoverClient } from './pushover.js';
import { WebhookClient } from './webhook.js';
import { HomeAssistantAlert } from './homeassistant.js';
import { AlertConfig } from './types.js';
import { GeneratedSignal } from '../signals/types.js';
import { getAssetMarket, isMarketOpen } from '../intelligence/trading-hours.js';

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
   * Dispatch alerts for multiple signals, aggregated per market and cycle.
   */
  async dispatchBatch(signals: GeneratedSignal[]): Promise<void> {
    for (const signal of signals) {
      await this.dispatchLegacy(signal);
    }

    if (!this.homeAssistant) return;

    const swedish: GeneratedSignal[] = [];
    const us: GeneratedSignal[] = [];

    for (const signal of signals) {
      if (signal.confidence < this.minConfidence) continue;
      if (signal.requires_judgment) continue;

      const market = getAssetMarket(signal.matched_asset_id);
      if (market === 'swedish') {
        swedish.push(signal);
      } else {
        us.push(signal);
      }
    }

    await this.dispatchAggregated(swedish, 'swedish');
    await this.dispatchAggregated(us, 'us');
  }

  /**
   * Send one aggregated notification for all pushable signals in a market.
   */
  private async dispatchAggregated(
    signals: GeneratedSignal[],
    market: 'swedish' | 'us'
  ): Promise<void> {
    const homeAssistant = this.homeAssistant;
    if (!homeAssistant) return;
    if (signals.length === 0) return;

    if (!isMarketOpen(market)) {
      for (const signal of signals) {
        console.log(`  Brewing signal ${signal.id} (${signal.matched_asset_name} ${signal.confidence}%) - ${market} market closed`);
      }
      return;
    }

    const pushable = signals.filter(signal =>
      signal.confidence >= this.haMinConfidence && Math.abs(signal.delta_pct) >= 15
    );

    if (pushable.length === 0) {
      for (const signal of signals) {
        console.log(`  Skip push ${signal.id} below HA threshold (${signal.confidence}%, delta ${signal.delta_pct.toFixed(0)}%)`);
      }
      return;
    }

    const byAsset = new Map<string, GeneratedSignal>();
    for (const signal of pushable) {
      const existing = byAsset.get(signal.matched_asset_id);
      if (!existing || signal.confidence > existing.confidence) {
        byAsset.set(signal.matched_asset_id, signal);
      }
    }

    const dedupedSignals = Array.from(byAsset.values())
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);

    if (dedupedSignals.length === 1) {
      await homeAssistant.send(dedupedSignals[0]);
    } else {
      await homeAssistant.sendAggregated(dedupedSignals, market);
    }

    console.log(`  Pushed aggregated ${market} HA alert (${dedupedSignals.length} assets)`);
  }

  /**
   * Legacy per-signal dispatch for non-HA channels.
   */
  private async dispatchLegacy(signal: GeneratedSignal): Promise<void> {
    if (signal.confidence < this.minConfidence) return;

    const promises: Promise<boolean>[] = [];
    if (this.pushover) promises.push(this.pushover.send(signal));
    if (this.webhook) promises.push(this.webhook.send(signal));

    await Promise.all(promises);
  }
}
