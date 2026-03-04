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
    const emoji = signal.polarity === 'context_dependent' ? '⚖️' : isBull ? '📈' : '📉';
    const direction = signal.polarity === 'context_dependent' ? 'BULL/BEAR'
      : isBull ? 'BULL' : 'BEAR';

    // Use short ticker if available, otherwise truncate asset name
    const ticker = TICKER_MAP[signal.matched_asset_name] ?? signal.matched_asset_name.substring(0, 6).toUpperCase();

    // Title kept very short (~24 chars max): "PS: 📈 BULL LMT 68%"
    const title = `PS: ${emoji} ${direction} ${ticker} ${signal.confidence}%`;

    // Ultra-short market summary (remove question marks, strip long phrases)
    const marketShort = signal.market_title
      .replace(/\?$/, '')
      .replace(/^Will /, '')
      .substring(0, 60);

    const deltaSign = signal.delta_pct > 0 ? '+' : '';
    const oddsLine = `${(signal.odds_before * 100).toFixed(0)}%→${(signal.odds_now * 100).toFixed(0)}% (${deltaSign}${signal.delta_pct.toFixed(1)}%)`;

    const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3100';
    const detailUrl = `${publicUrl}/api/signals/${signal.id}/detail`;

    const message = `${marketShort}\n${oddsLine}\n🔗 ${detailUrl}`;

    const servicePath = this.notifyService.replace('.', '/');
    console.log(`Sending HA notification for signal: ${signal.id} (confidence: ${signal.confidence}%) → ${this.haUrl}/api/services/${servicePath}`);

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
            url: detailUrl
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
}
