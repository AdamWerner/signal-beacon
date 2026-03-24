import { describe, expect, it } from 'vitest';
import {
  getStockholmClockPartsAt,
  getStockholmDateStringAt,
  getAssetMarket,
  isApproachingPreMarketWindowAt,
  isMarketOpenAt,
  isPreMarketWindowAt,
  EUROPEAN_SESSION_ASSETS,
  SWEDISH_MARKET_ASSETS
} from './trading-hours.js';

describe('trading-hours per asset/market', () => {
  it('blocks US asset pushes during OMX hours (09:48 CET)', () => {
    const date = new Date('2026-03-05T08:48:00Z'); // 09:48 CET
    expect(getAssetMarket('sp500')).toBe('us');
    expect(isMarketOpenAt('us', date)).toBe(false);
    expect(isMarketOpenAt('swedish', date)).toBe(true);
  });

  it('recognizes US pre-market briefing window at 15:15 CET', () => {
    const date = new Date('2026-03-05T14:15:00Z'); // 15:15 CET
    expect(isPreMarketWindowAt('us', date)).toBe(true);
    expect(isMarketOpenAt('us', date)).toBe(false);
  });

  it('recognizes US cash market open after 15:30 CET', () => {
    const date = new Date('2026-03-05T14:35:00Z'); // 15:35 CET
    expect(isMarketOpenAt('us', date)).toBe(true);
  });

  it('treats Spotify as US-hours and not OMX-hours', () => {
    expect(getAssetMarket('tech-spotify')).toBe('us');
    expect(SWEDISH_MARKET_ASSETS.has('tech-spotify')).toBe(false);
  });

  it('treats European-listed assets as daytime European session, not Swedish Focus', () => {
    expect(getAssetMarket('oil-equinor')).toBe('swedish');
    expect(getAssetMarket('oil-shell')).toBe('swedish');
    expect(getAssetMarket('pharma-novo')).toBe('swedish');
    expect(EUROPEAN_SESSION_ASSETS.has('oil-equinor')).toBe(true);
    expect(SWEDISH_MARKET_ASSETS.has('oil-equinor')).toBe(false);
  });

  it('uses deterministic Stockholm clock parts for the Swedish pre-market approach window', () => {
    const date = new Date('2026-03-19T07:09:53Z'); // 08:09:53 CET
    expect(getStockholmClockPartsAt(date)).toEqual({ day: 4, minutes: 8 * 60 + 9 });
    expect(isApproachingPreMarketWindowAt(date)).toBe(true);
  });

  it('formats Stockholm dates deterministically as YYYY-MM-DD', () => {
    const date = new Date('2026-03-19T07:09:53Z');
    expect(getStockholmDateStringAt(date)).toBe('2026-03-19');
  });
});
