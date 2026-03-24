import { describe, expect, it, vi } from 'vitest';
import { MarketDiscoverer } from './market-discoverer.js';

describe('MarketDiscoverer.revalidateTrackedMarkets', () => {
  it('resolves tracked markets that no longer match current ontology rules', () => {
    const store = {
      findAll: () => [{
        id: 1,
        condition_id: 'cond_1',
        gamma_id: null,
        slug: 'joe-rogan',
        event_slug: null,
        title: 'Will Elon Musk go on Joe Rogan before June 30?',
        description: null,
        category: 'culture',
        matched_asset_ids: '["tech-spotify"]',
        relevance_score: 0.4,
        is_active: true,
        volume: null,
        liquidity: null,
        discovered_at: '2026-03-19 10:00:00',
        resolved_at: null,
        last_checked_at: null
      }],
      markAsResolved: vi.fn(),
      updateMatching: vi.fn()
    } as any;

    const ontology = {
      matchMarket: () => [],
      calculateRelevance: () => 0
    } as any;

    const discoverer = new MarketDiscoverer({} as any, ontology, store, 0.4);
    const result = discoverer.revalidateTrackedMarkets();

    expect(result).toEqual({ resolved: 1, updated: 0 });
    expect(store.markAsResolved).toHaveBeenCalledWith('cond_1');
  });
});
