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
  'gaming-evolution', 'retail-hm', 'auto-volvo', 'omx30'
]);

// European-listed names trade in the same daytime window Adam can act on from Avanza,
// but they should not appear in Swedish Focus unless they are in SWEDISH_MARKET_ASSETS.
export const EUROPEAN_SESSION_ASSETS = new Set([
  'defense-rheinmetall', 'defense-bae',
  'oil-equinor', 'oil-shell',
  'pharma-novo', 'renewables-vestas'
]);

export const US_MARKET_ASSETS = new Set([
  'defense-lockheed',
  'oil-conocophillips', 'oil-exxon',
  'ai-nvidia', 'ai-palantir', 'ai-crowdstrike',
  'ev-tesla', 'mining-freeport',
  'shipping-zim', 'nuclear-sprott',
  'crypto-coinbase', 'sp500', 'nasdaq100', 'tech-spotify'
]);

export function getAssetMarket(assetId: string): 'swedish' | 'us' {
  if (SWEDISH_MARKET_ASSETS.has(assetId)) return 'swedish';
  if (EUROPEAN_SESSION_ASSETS.has(assetId)) return 'swedish';
  return 'us';
}

const STOCKHOLM_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Stockholm',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

const STOCKHOLM_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

export function getStockholmClockPartsAt(now = new Date()): { minutes: number; day: number } {
  const parts = STOCKHOLM_TIME_FORMATTER.formatToParts(now);
  const weekday = parts.find(part => part.type === 'weekday')?.value ?? 'Mon';
  const hour = parseInt(parts.find(part => part.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find(part => part.type === 'minute')?.value ?? '0', 10);
  return {
    minutes: hour * 60 + minute,
    day: WEEKDAY_TO_INDEX[weekday] ?? 1
  };
}

export function getStockholmDateStringAt(now = new Date()): string {
  const parts = STOCKHOLM_DATE_FORMATTER.formatToParts(now);
  const year = parts.find(part => part.type === 'year')?.value ?? '1970';
  const month = parts.find(part => part.type === 'month')?.value ?? '01';
  const day = parts.find(part => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

export function isMarketOpenAt(market: 'swedish' | 'us', now: Date): boolean {
  const { minutes, day } = getStockholmClockPartsAt(now);
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
  const { minutes, day } = getStockholmClockPartsAt(now);
  if (day === 0 || day === 6) return false;
  const cfg = TRADING_HOURS[market];
  const push = cfg.preMarketPush.hour * 60 + cfg.preMarketPush.minute;
  const open = cfg.open.hour * 60 + cfg.open.minute;
  // Extend window 45 min past market open to survive a 30-min dormant sleep gap
  // (pushed_at guard prevents double-sending)
  return minutes >= push && minutes < open + 45;
}

export function isPreMarketWindow(market: 'swedish' | 'us'): boolean {
  return isPreMarketWindowAt(market, new Date());
}

export function isApproachingPreMarketWindowAt(now: Date, leadMinutes = 60): boolean {
  const { minutes, day } = getStockholmClockPartsAt(now);
  if (day === 0 || day === 6) return false;

  for (const market of Object.keys(TRADING_HOURS) as Array<'swedish' | 'us'>) {
    const cfg = TRADING_HOURS[market];
    const push = cfg.preMarketPush.hour * 60 + cfg.preMarketPush.minute;
    if (minutes >= push - leadMinutes && minutes < push) {
      return true;
    }
  }

  return false;
}

export function isApproachingPreMarketWindow(leadMinutes = 60): boolean {
  return isApproachingPreMarketWindowAt(new Date(), leadMinutes);
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
