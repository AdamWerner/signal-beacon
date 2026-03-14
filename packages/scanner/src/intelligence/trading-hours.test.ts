import { describe, expect, it } from 'vitest';
import {
  getAssetMarket,
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
});
