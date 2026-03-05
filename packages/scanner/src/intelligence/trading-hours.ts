// All times in CET/CEST (Europe/Stockholm)
export const TRADING_HOURS = {
  swedish: {
    open:  { hour: 9,  minute: 0  },   // OMX opens 09:00
    close: { hour: 17, minute: 30 },   // OMX closes 17:30
    preMarketPush: { hour: 8, minute: 45 },
  },
  us: {
    open:  { hour: 15, minute: 30 },   // NYSE opens 15:30 CET
    close: { hour: 22, minute: 0  },   // NYSE closes 22:00 CET
    preMarketPush: { hour: 15, minute: 15 },
  }
} as const;

export const SWEDISH_MARKET_ASSETS = new Set([
  'defense-saab', 'steel-ssab', 'mining-boliden', 'telecom-ericsson',
  'gaming-evolution', 'retail-hm', 'auto-volvo', 'tech-spotify', 'omx30'
]);

export const US_MARKET_ASSETS = new Set([
  'defense-lockheed', 'defense-rheinmetall', 'defense-bae',
  'oil-equinor', 'oil-conocophillips', 'oil-shell', 'oil-exxon',
  'ai-nvidia', 'ai-palantir', 'ai-crowdstrike',
  'ev-tesla', 'mining-freeport', 'pharma-novo',
  'shipping-zim', 'renewables-vestas', 'nuclear-sprott',
  'crypto-coinbase', 'sp500', 'nasdaq100'
]);

export function getAssetMarket(assetId: string): 'swedish' | 'us' {
  if (SWEDISH_MARKET_ASSETS.has(assetId)) return 'swedish';
  return 'us';
}

function getStockholmMinutes(now = new Date()): { minutes: number; day: number } {
  const stockholmStr = now.toLocaleString('en-US', { timeZone: 'Europe/Stockholm' });
  const s = new Date(stockholmStr);
  return {
    minutes: s.getHours() * 60 + s.getMinutes(),
    day: s.getDay()
  };
}

export function isMarketOpenAt(market: 'swedish' | 'us', now: Date): boolean {
  const { minutes, day } = getStockholmMinutes(now);
  if (day === 0 || day === 6) return false;
  const cfg = TRADING_HOURS[market];
  const open  = cfg.open.hour  * 60 + cfg.open.minute;
  const close = cfg.close.hour * 60 + cfg.close.minute;
  return minutes >= open && minutes < close;
}

export function isMarketOpen(market: 'swedish' | 'us'): boolean {
  return isMarketOpenAt(market, new Date());
}

export function isPreMarketWindowAt(market: 'swedish' | 'us', now: Date): boolean {
  const { minutes, day } = getStockholmMinutes(now);
  if (day === 0 || day === 6) return false;
  const cfg = TRADING_HOURS[market];
  const push = cfg.preMarketPush.hour * 60 + cfg.preMarketPush.minute;
  const open = cfg.open.hour * 60 + cfg.open.minute;
  return minutes >= push && minutes < open;
}

export function isPreMarketWindow(market: 'swedish' | 'us'): boolean {
  return isPreMarketWindowAt(market, new Date());
}

/**
 * Returns true if the signal should be pushed immediately (during market hours, high confidence).
 * Otherwise it brews until the next morning briefing.
 */
export function shouldPushSignal(assetId: string, confidence: number): boolean {
  const market = getAssetMarket(assetId);
  if (isMarketOpen(market)) {
    return confidence >= 70;
  }
  return false;
}
