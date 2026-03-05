import { GeneratedSignal } from '../signals/types.js';

const TICKER_MAP: Record<string, string> = {
  'Lockheed Martin': 'LMT',
  'S&P 500': 'SP500',
  'Tesla': 'TSLA',
  'Equinor': 'EQNR',
  'Shell': 'SHEL',
  'ConocoPhillips': 'COP',
  'Exxon Mobil': 'XOM',
  'ZIM Integrated Shipping Services': 'ZIM',
  'Ericsson B': 'ERIC',
  'Saab B': 'SAAB',
  'Boliden': 'BOL',
  'SSAB': 'SSAB',
  'Coinbase Global': 'COIN',
  'CrowdStrike Holdings': 'CRWD',
  'Evolution Gaming': 'EVO',
  'H&M': 'HM',
  'Sprott Physical Uranium Trust': 'SRUUF',
  'NVIDIA': 'NVDA',
  'Palantir Technologies': 'PLTR',
  'BAE Systems': 'BAESY',
  'Rheinmetall': 'RNMBY',
  'Vestas': 'VWDRY',
  'Novo Nordisk B': 'NVO',
  'Freeport-McMoRan': 'FCX',
  'Volvo Group': 'VOLVO',
  'Spotify Technology': 'SPOT',
  'NASDAQ 100': 'NDX',
  'OMX 30': 'OMX30'
};

export class HomeAssistantAlert {
  constructor(
    private haUrl: string,
    private haToken: string,
    private notifyService: string
  ) {}

  /**
   * Send a single-signal push notification.
   */
  async send(signal: GeneratedSignal): Promise<boolean> {
    const action = signal.suggested_action.toLowerCase();
    const isBull = action.includes('bull');
    const emoji = isBull ? '📈' : '📉';
    const direction = isBull ? 'BULL' : 'BEAR';

    const ticker = this.getTicker(signal.matched_asset_name, 6);
    const title = `PS: ${emoji} ${direction} ${ticker} ${signal.confidence}%`;

    const deltaSign = signal.delta_pct > 0 ? '+' : '';
    const oddsLine = `${(signal.odds_before * 100).toFixed(0)}%->${(signal.odds_now * 100).toFixed(0)}% (${deltaSign}${signal.delta_pct.toFixed(0)}%)`;
    const reason = this.generateShortReason(signal, isBull);
    const message = `${reason}\n${oddsLine}`;

    const publicUrl = process.env.PUBLIC_URL || 'http://192.168.0.15:3100';
    const detailUrl = `${publicUrl}/api/signals/${signal.id}/detail`;

    return this.pushNotification(title, message, detailUrl, signal.id);
  }

  /**
   * Send a single aggregated push for a batch of actionable signals.
   */
  async sendAggregated(signals: GeneratedSignal[], market: 'swedish' | 'us'): Promise<boolean> {
    if (signals.length === 0) {
      return false;
    }

    const flag = market === 'swedish' ? '🇸🇪' : '🇺🇸';
    const topSignal = signals[0];
    const topDirection = topSignal.suggested_action.toLowerCase().includes('bull') ? 'BULL' : 'BEAR';
    const topTicker = this.getTicker(topSignal.matched_asset_name, 6);

    const title = signals.length === 1
      ? `PS: ${flag} ${topDirection} ${topTicker} ${topSignal.confidence}%`
      : `PS: ${flag} ${signals.length} signals - ${topDirection} ${topTicker} leads`;

    const summaryParts = signals.slice(0, 3).map(signal => {
      const directionEmoji = signal.suggested_action.toLowerCase().includes('bull') ? '📈' : '📉';
      return `${directionEmoji} ${this.getTicker(signal.matched_asset_name, 5)} ${signal.confidence}%`;
    });

    const message = summaryParts.join(' | ');

    const publicUrl = process.env.PUBLIC_URL || 'http://192.168.0.15:3100';
    const detailUrl = `${publicUrl}/api/signals/${topSignal.id}/detail`;

    return this.pushNotification(title, message, detailUrl, `agg_${market}`);
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

  private generateShortReason(signal: GeneratedSignal, isBull: boolean): string {
    const marketTitle = signal.market_title
      .replace(/^Will /, '')
      .replace(/\?$/, '')
      .substring(0, 55);

    const direction = isBull ? 'UP' : 'DOWN';
    return `${marketTitle} -> ${signal.matched_asset_name} likely ${direction}`;
  }

  private getTicker(assetName: string, fallbackSlice: number): string {
    return TICKER_MAP[assetName] ?? assetName.substring(0, fallbackSlice).toUpperCase();
  }
}
