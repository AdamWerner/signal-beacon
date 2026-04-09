import { describe, expect, it } from 'vitest';
import { extractCatalystSourceFamilies } from './dispatcher.js';

describe('extractCatalystSourceFamilies', () => {
  it('reads structured families — reasoning containing "macro" does not add macro when families are set', () => {
    // Regression: old code parsed reasoning strings, so a [macro:event] boost tag
    // would add 'macro' to the source set even for pure news+technical hybrids.
    const signal = {
      confirming_source_families: ['news', 'technical'],
      reasoning: 'Catalyst convergence: news spike [macro:FOMC,+15min] [vol:normal]'
    };
    const types = extractCatalystSourceFamilies(signal);
    expect(types.has('macro')).toBe(false);
    expect(types.has('news')).toBe(true);
    expect(types.has('technical')).toBe(true);
    expect(types.size).toBe(2);
  });

  it('reads rss_news family from structured field even with no finviz/news: tokens in reasoning', () => {
    // Regression: old code only detected 'news' if reasoning contained 'finviz',
    // 'volume spike', or '[news:+'. RSS-origin news ('rss_news') was invisible
    // to the evidence gate.
    const signal = {
      confirming_source_families: ['rss_news'],
      reasoning: 'Catalyst convergence: 3 aligned sources point BULL Equinor.'
    };
    const types = extractCatalystSourceFamilies(signal);
    expect(types.has('rss_news')).toBe(true);
    expect(types.size).toBe(1);
  });

  it('returns empty set when confirming_source_families is absent', () => {
    const signal = {
      confirming_source_families: undefined,
      reasoning: 'poly-confirms cross-source technical macro insider finviz'
    };
    const types = extractCatalystSourceFamilies(signal);
    expect(types.size).toBe(0);
  });
});
