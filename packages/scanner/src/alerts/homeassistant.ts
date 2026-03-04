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
};

export class HomeAssistantAlert {
  constructor(
    private haUrl: string,
    private haToken: string,
    private notifyService: string
  ) {}

  async send(signal: GeneratedSignal): Promise<boolean> {
    const action = signal.suggested_action.toLowerCase();
    const isBull = action.includes('bull');
    const emoji = isBull ? '📈' : '📉';
    const direction = isBull ? 'BULL' : 'BEAR';

    const ticker = TICKER_MAP[signal.matched_asset_name] ?? signal.matched_asset_name.substring(0, 6).toUpperCase();
    const title = `PS: ${emoji} ${direction} ${ticker} ${signal.confidence}%`;

    const deltaSign = signal.delta_pct > 0 ? '+' : '';
    const oddsLine = `${(signal.odds_before * 100).toFixed(0)}%→${(signal.odds_now * 100).toFixed(0)}% (${deltaSign}${signal.delta_pct.toFixed(0)}%)`;
    const reason = this.generateShortReason(signal, isBull);
    const message = `${reason}\n${oddsLine}`;

    const publicUrl = process.env.PUBLIC_URL || 'http://192.168.0.15:3100';
    const detailUrl = `${publicUrl}/api/signals/${signal.id}/detail`;

    const servicePath = this.notifyService.replace('.', '/');
    console.log(`Sending HA notification: ${title} → ${this.haUrl}/api/services/${servicePath}`);

    try {
      const response = await fetch(`${this.haUrl}/api/services/${servicePath}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.haToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title,
          message,
          data: {
            priority: 'high',
            ttl: 0,
            tag: signal.id,
            url: detailUrl,
            clickAction: detailUrl,
            actions: [
              { action: 'URI', title: 'View Signal', uri: detailUrl }
            ]
          }
        })
      });

      if (response.ok) {
        console.log(`✓ HA notification sent for signal ${signal.id}`);
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
    const market = signal.market_title
      .replace(/^Will /, '')
      .replace(/\?$/, '')
      .substring(0, 55);
    const direction = isBull ? 'UP' : 'DOWN';
    return `${market} → ${signal.matched_asset_name} likely ${direction}`;
  }
}
