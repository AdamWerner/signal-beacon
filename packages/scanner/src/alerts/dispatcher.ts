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
  private verificationRequiredForPush: boolean;
  private onSignalsPushed?: (signalIds: string[], market: 'swedish' | 'us') => void;

  constructor(config: AlertConfig) {
    this.minConfidence = config.minConfidence || 50;
    this.haMinConfidence = config.homeAssistant?.minConfidence ?? 65;
    this.verificationRequiredForPush = config.verificationRequiredForPush ?? true;
    this.onSignalsPushed = config.onSignalsPushed;

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
   * Returns actual counts of pushed and brewed signals.
   */
  async dispatchBatch(signals: GeneratedSignal[]): Promise<{ pushedSwedish: number; pushedUs: number; brewed: number }> {
    for (const signal of signals) {
      await this.dispatchLegacy(signal);
    }

    if (!this.homeAssistant) {
      return { pushedSwedish: 0, pushedUs: 0, brewed: 0 };
    }

    const swedish: GeneratedSignal[] = [];
    const us: GeneratedSignal[] = [];

    for (const signal of signals) {
      if (signal.confidence < this.minConfidence) continue;
      if (signal.requires_judgment) continue;
      if (this.verificationRequiredForPush && !this.isEligibleByVerification(signal)) {
        console.log(
          `  Skip push ${signal.id} not verification-approved ` +
          `(${signal.verification_status}/${signal.verification_source})`
        );
        continue;
      }

      const market = getAssetMarket(signal.matched_asset_id);
      if (market === 'swedish') {
        swedish.push(signal);
      } else {
        us.push(signal);
      }
    }

    const pushedSwedish = await this.dispatchAggregated(swedish, 'swedish');
    const pushedUs = await this.dispatchAggregated(us, 'us');
    const brewed = (swedish.length - pushedSwedish) + (us.length - pushedUs);

    return { pushedSwedish, pushedUs, brewed };
  }

  /**
   * Send one aggregated notification for all pushable signals in a market.
   * Returns count of assets actually pushed.
   */
  private async dispatchAggregated(
    signals: GeneratedSignal[],
    market: 'swedish' | 'us'
  ): Promise<number> {
    const homeAssistant = this.homeAssistant;
    if (!homeAssistant) return 0;
    if (signals.length === 0) return 0;

    if (!isMarketOpen(market)) {
      for (const signal of signals) {
        console.log(`  Brewing signal ${signal.id} (${signal.matched_asset_name} ${signal.confidence}%) - ${market} market closed`);
      }
      return 0;
    }

    const pushable = signals.filter(signal =>
      signal.confidence >= this.haMinConfidence &&
      Math.abs(signal.delta_pct) >= 15 &&
      signal.verification_status === 'approved'
    );

    if (pushable.length === 0) {
      for (const signal of signals) {
        console.log(`  Skip push ${signal.id} below HA threshold (${signal.confidence}%, delta ${signal.delta_pct.toFixed(0)}%)`);
      }
      return 0;
    }

    const byAsset = new Map<string, GeneratedSignal>();
    for (const signal of pushable) {
      const existing = byAsset.get(signal.matched_asset_id);
      if (!existing || signal.confidence > existing.confidence) {
        byAsset.set(signal.matched_asset_id, signal);
      }
    }

    const dedupedSignals = Array.from(byAsset.values()).sort((a, b) => b.confidence - a.confidence);
    const topSignal = dedupedSignals[0];
    if (!topSignal) return 0;

    const DRY_RUN = process.env.DRY_RUN === 'true';
    if (DRY_RUN) {
      const dryTitle = `${topSignal.suggested_action} ${topSignal.matched_asset_name} ${topSignal.confidence}%`;
      const dryMessage = `${topSignal.reasoning} | ${topSignal.verification_reason}`;
      console.log(`[DRY_RUN] Would push: ${dryTitle} | ${dryMessage}`);
      if (this.onSignalsPushed) {
        this.onSignalsPushed([topSignal.id], market);
      }
      return 1;
    }

    const sent = await homeAssistant.send(topSignal);

    if (!sent) {
      console.warn(`  HA push attempt failed for ${market} market (${topSignal.matched_asset_name})`);
      return 0;
    }

    if (this.onSignalsPushed) {
      this.onSignalsPushed([topSignal.id], market);
    }

    console.log(`  Pushed top ${market} HA alert (${topSignal.matched_asset_name} ${topSignal.confidence}%)`);
    return 1;
  }

  /**
   * Legacy per-signal dispatch for non-HA channels.
   */
  private async dispatchLegacy(signal: GeneratedSignal): Promise<void> {
    if (signal.confidence < this.minConfidence) return;
    if (this.verificationRequiredForPush && !this.isEligibleByVerification(signal)) return;

    const promises: Promise<boolean>[] = [];
    if (this.pushover) promises.push(this.pushover.send(signal));
    if (this.webhook) promises.push(this.webhook.send(signal));

    await Promise.all(promises);
  }

  private isEligibleByVerification(signal: GeneratedSignal): boolean {
    if (signal.verification_status !== 'approved') return false;
    if (signal.verification_source === 'guard_allowlist') return true;
    return signal.verification_source === 'claude' || signal.verification_source === 'guard';
  }
}
