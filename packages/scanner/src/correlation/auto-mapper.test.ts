import { describe, expect, it } from 'vitest';
import { OntologyEngine } from './ontology.js';
import { AutoMapper } from './auto-mapper.js';

describe('AutoMapper.getMatchedKeywordsForAsset', () => {
  const mapper = new AutoMapper(new OntologyEngine(), null);

  it('requires title keyword evidence and ignores description-only matches', () => {
    const keywords = mapper.getMatchedKeywordsForAsset({
      id: 1,
      condition_id: 'cond_1',
      gamma_id: null,
      event_slug: null,
      slug: 'ohio-osb-license',
      title: 'Will Ohio Revoke Any OSB License Over Event-Contract Activity by March 31?',
      description: 'This market refers to an online sports betting provider licensed in Ohio.',
      category: 'gaming',
      matched_asset_ids: '["gaming-evolution"]',
      relevance_score: 0.4,
      discovered_at: '2026-03-19 08:00:00',
      resolved_at: null,
      is_active: true,
      volume: 0,
      liquidity: 0,
      last_checked_at: '2026-03-19 08:00:00'
    }, 'gaming-evolution');

    expect(keywords).toEqual([]);
  });
});
