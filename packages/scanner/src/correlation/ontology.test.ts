import { describe, expect, it } from 'vitest';
import { OntologyEngine } from './ontology.js';

describe('OntologyEngine OMX30 macro matching', () => {
  const ontology = new OntologyEngine();

  it('matches explicit negative macro titles to omx30', () => {
    const matches = ontology.matchMarket(
      'Will Trump trigger a new China trade war before June 30?',
      null,
      'economics'
    );

    expect(matches.some(match => match.assetId === 'omx30')).toBe(true);
  });

  it('does not match celebrity/media noise to omx30', () => {
    const matches = ontology.matchMarket(
      'Will Elon Musk go on Joe Rogan before June 30?',
      null,
      'culture'
    );

    expect(matches.some(match => match.assetId === 'omx30')).toBe(false);
  });

  it('does not match substring collisions like CUDA inside Barracuda', () => {
    const matches = ontology.matchMarket(
      'AHL: Coachella Valley Firebirds vs. San Jose Barracuda',
      null,
      'sports'
    );

    expect(matches.some(match => match.assetId === 'ai-nvidia')).toBe(false);
  });

  it('does not match music-release celebrity titles to spotify', () => {
    const matches = ontology.matchMarket(
      'Will Lil Uzi Vert release a new song in 2026?',
      null,
      'entertainment'
    );

    expect(matches.some(match => match.assetId === 'tech-spotify')).toBe(false);
  });
});
