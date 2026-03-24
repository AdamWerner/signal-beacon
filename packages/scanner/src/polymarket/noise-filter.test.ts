import { describe, expect, it } from 'vitest';
import { isNoiseMarketQuestion } from './noise-filter.js';

describe('noise filter', () => {
  it('blocks celebrity and chart noise that used to leak into Spotify', () => {
    expect(isNoiseMarketQuestion('Will Elon Musk go on Joe Rogan before June 30?')).toBe(true);
    expect(isNoiseMarketQuestion('Will Bad Bunny have a #1 hit in April?')).toBe(true);
    expect(isNoiseMarketQuestion('Will Lil Uzi Vert release a new song in 2026?')).toBe(true);
    expect(isNoiseMarketQuestion('New Playboi Carti Album before GTA VI?')).toBe(true);
  });

  it('blocks climate and Powell phrase-count markets', () => {
    expect(
      isNoiseMarketQuestion('Will the minimum Arctic sea ice extent this summer be at least 5m square kilometers?')
    ).toBe(true);
    expect(
      isNoiseMarketQuestion('Will Powell say "Dollar" 2+ times during March press conference?')
    ).toBe(true);
    expect(
      isNoiseMarketQuestion('Will Trump say "Trade" or "Tariff" 3+ times during events with Japanese PM?')
    ).toBe(true);
    expect(
      isNoiseMarketQuestion('AHL: Coachella Valley Firebirds vs. San Jose Barracuda')
    ).toBe(true);
  });
});
