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

    // Final deep verification — one Claude call with full context, only fires when about to push
    const deepResult = await this.deepVerify(topSignal);
    if (deepResult) {
      if (deepResult.verdict === 'reject') {
        console.log(`  [deep-verify] BLOCKED push: ${deepResult.reason}`);
        return 0;
      }
      topSignal.verification_reason = deepResult.reason;
      if (deepResult.confidence_adjustment) {
        topSignal.confidence = Math.max(0, Math.min(
          topSignal.confidence + deepResult.confidence_adjustment, 92
        ));
      }
    }

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

  /**
   * Premium Claude call — only fires when a signal is about to hit the trader's phone.
   * Provides final deep analysis with full signal context.
   */
  private async deepVerify(signal: GeneratedSignal): Promise<{
    verdict: 'approve' | 'reject';
    reason: string;
    confidence_adjustment: number;
  } | null> {
    const isBull = signal.suggested_action.toLowerCase().includes('bull');
    const oddsBefore = (signal.odds_before * 100).toFixed(1);
    const oddsNow = (signal.odds_now * 100).toFixed(1);
    const deltaSign = signal.delta_pct > 0 ? '+' : '';
    const momentumTag = signal.reasoning.match(/Momentum: (\w+)/)?.[1] ?? 'unknown';
    const sectorTag = signal.reasoning.match(/\[sector: .+?\]/)?.[0] ?? 'none';

    // Query DB for live reinforcement data
    let reinforcingCount = 0;
    let newsSourceCount = 0;
    try {
      const { getDatabase } = await import('../storage/db.js');
      const db = getDatabase();
      const dirWord = isBull ? 'BULL' : 'BEAR';
      reinforcingCount = (db.prepare(`
        SELECT COUNT(*) as c FROM signals
        WHERE matched_asset_id = ?
          AND suggested_action LIKE '%' || ? || '%'
          AND timestamp >= datetime('now', '-24 hours')
          AND verification_status = 'approved'
      `).get(signal.matched_asset_id, dirWord) as any)?.c ?? 0;

      const asset = signal.matched_asset_name.toLowerCase();
      newsSourceCount = (db.prepare(`
        SELECT COUNT(DISTINCT account_handle) as c FROM tweet_snapshots
        WHERE scraped_at >= datetime('now', '-6 hours')
          AND LOWER(tweet_text) LIKE '%' || ? || '%'
      `).get(asset) as any)?.c ?? 0;
    } catch {}

    const prompt = `You are the final gatekeeper at a quantitative trading desk. A signal is about to be sent to a trader's phone for IMMEDIATE action on a leveraged X3 certificate (5-30 min holding period on Avanza, Swedish broker).

SIGNAL:
- Asset: ${signal.matched_asset_name}
- Direction: ${isBull ? 'BULL (long)' : 'BEAR (short)'}
- Confidence: ${signal.confidence}%
- Polymarket: "${signal.market_title}"
- Odds: ${oddsBefore}% -> ${oddsNow}% (${deltaSign}${signal.delta_pct.toFixed(1)}%)
- Momentum: ${momentumTag}
${signal.whale_detected ? `- Whale activity: $${(signal.whale_amount_usd || 0).toLocaleString()}` : '- No whale activity'}
- Reinforcing signals (24h): ${reinforcingCount} other approved signals for same asset + direction
- News corroboration: ${newsSourceCount} news sources mentioned ${signal.matched_asset_name} in last 6h
- Sector pattern: ${sectorTag}

YOUR TASK: Would you approve sending this as a LIVE TRADE ALERT? Consider:
1. Is the causal mechanism specific and strong? (e.g., "OPEC cut -> oil price up -> Equinor revenue up" is strong; "general uncertainty -> S&P might drop" is weak)
2. Will the stock/index likely MOVE within 30 minutes of this event becoming known?
3. Is this already priced in? (If the Polymarket odds only moved 8% on an event the stock market has known about for days, it's stale.)
4. Is the leverage direction correct? (Direct polarity = odds up means BULL; inverse = odds up means BEAR)

Respond JSON ONLY, no other text:
{"verdict":"approve","reason":"1-2 sentences a trader can act on","confidence_adjustment":-10..10}
or
{"verdict":"reject","reason":"why not","confidence_adjustment":0}`;

    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      for (const bin of ['claude', 'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude', '/usr/local/bin/claude']) {
        try {
          const { stdout } = await execFileAsync(bin, ['-p', prompt], { timeout: 30000 });
          const cleaned = stdout.trim().replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(cleaned);
          if (parsed.verdict === 'approve' || parsed.verdict === 'reject') {
            const { trackClaudeCall } = await import('../utils/claude-usage.js');
            trackClaudeCall('deep-verify-pre-push');
            return parsed;
          }
        } catch { continue; }
      }
    } catch {}
    return null; // Claude unavailable — proceed without deep verification
  }
}
