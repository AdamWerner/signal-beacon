import { PushoverConfig } from './types.js';
import { GeneratedSignal } from '../signals/types.js';

export class PushoverClient {
  constructor(private config: PushoverConfig) {}

  async send(signal: GeneratedSignal): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    try {
      const message = this.formatMessage(signal);
      const title = `PolySignal: ${signal.suggested_action}`;

      const response = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          token: this.config.appToken,
          user: this.config.userKey,
          title,
          message,
          priority: signal.confidence >= 70 ? 1 : 0,
          url: `https://polymarket.com/event/${signal.market_slug}`,
          url_title: 'View on Polymarket'
        })
      });

      if (!response.ok) {
        console.error('Pushover API error:', await response.text());
        return false;
      }

      console.log(`✓ Pushover alert sent for signal ${signal.id}`);
      return true;
    } catch (error) {
      console.error('Failed to send Pushover alert:', error);
      return false;
    }
  }

  private formatMessage(signal: GeneratedSignal): string {
    const lines: string[] = [];

    lines.push(`${signal.market_title.substring(0, 100)}`);
    lines.push('');
    lines.push(`${signal.matched_asset_name}: ${signal.suggested_action}`);
    lines.push(`Confidence: ${signal.confidence}%`);
    lines.push('');
    lines.push(`Δ: ${signal.delta_pct > 0 ? '+' : ''}${signal.delta_pct.toFixed(1)}% in ${signal.time_window_minutes}min`);

    if (signal.whale_detected && signal.whale_amount_usd) {
      lines.push(`🐋 Whale: $${(signal.whale_amount_usd / 1000).toFixed(0)}K`);
    }

    lines.push('');
    lines.push(signal.reasoning.substring(0, 200));

    return lines.join('\n');
  }
}
