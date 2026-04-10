import { GeneratedSignal } from '../signals/types.js';
import { buildHumanReason } from '../signals/reason-builder.js';
import { getShortTicker } from '../utils/ticker-map.js';

export class HomeAssistantAlert {
  constructor(
    private haUrl: string,
    private haToken: string,
    private notifyService: string
  ) {}

  // Aggregated multi-signal sends have been removed. One push = one signal.
  async send(signal: GeneratedSignal): Promise<boolean> {
    const action = signal.suggested_action.toLowerCase();
    const isBull = action.includes('bull');
    const emoji = signal.signal_origin === 'catalyst_convergence'
      ? '⚡'
      : (isBull ? '📈' : '📉');
    const direction = isBull ? 'BULL' : 'BEAR';

    const ticker = this.getTicker(signal.matched_asset_id, signal.matched_asset_name, 6);
    const title = `PS: ${emoji} ${direction} ${ticker} ${signal.confidence}%`;
    const message = buildHumanReason(signal);

    const publicUrl = process.env.PUBLIC_URL || 'http://192.168.0.15:3100';
    const detailUrl = `${publicUrl}/api/signals/${signal.id}/detail`;

    return this.pushNotification(title, message, detailUrl, signal.id);
  }

  /**
   * Low-level push to Home Assistant.
   */
  private async pushNotification(
    title: string,
    message: string,
    url: string,
    tag: string
  ): Promise<boolean> {
    if (process.env.DRY_RUN === 'true') {
      console.log(`[DRY_RUN] Would push: ${title} | ${message.substring(0, 100)}`);
      return true;
    }

    const servicePath = this.notifyService.replace('.', '/');
    const endpoint = `${this.haUrl}/api/services/${servicePath}`;
    console.log(`Sending HA notification: ${title} -> ${endpoint}`);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.haToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title,
          message,
          data: {
            priority: 'high',
            ttl: 0,
            tag,
            url,
            clickAction: url,
            actions: [
              { action: 'URI', title: 'View Signal', uri: url }
            ]
          }
        })
      });

      if (response.ok) {
        console.log(`HA notification sent: ${tag}`);
      } else {
        console.error(`Home Assistant notification failed: ${response.status} ${response.statusText}`);
      }

      return response.ok;
    } catch (error) {
      console.error('Home Assistant notification error:', error);
      return false;
    }
  }

  private getTicker(assetId: string, assetName: string, fallbackSlice: number): string {
    return getShortTicker(assetId, assetName.substring(0, fallbackSlice).toUpperCase());
  }
}
