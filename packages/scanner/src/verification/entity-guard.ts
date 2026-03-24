import { KnowledgeBase } from './knowledge-base.js';
import { GuardDecision, VerificationContext } from './types.js';

const LEGAL_EVENT_TERMS = [
  'arrest',
  'arrested',
  'indicted',
  'indictment',
  'charged',
  'trial',
  'prison',
  'jail',
  'lawsuit',
  'sued',
  'convicted',
  'fraud'
];

const ORG_HINTS = [
  'federal reserve',
  'fed',
  'opec',
  'nato',
  'ecb',
  'riksbank',
  'tesla',
  'nvidia',
  'spotify',
  'saab',
  'ericsson',
  'volvo',
  'equinor'
];

const EVOLUTION_BLOCK_TERMS = [
  'sports betting',
  'sportsbook',
  'osb',
  'event-contract',
  'license',
  'licensed in ohio',
  'ohio casino control commission',
  'type a license'
];

const EVOLUTION_POSITIVE_TERMS = [
  'igaming',
  'live casino',
  'online casino',
  'live dealer',
  'evolution gaming'
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some(term => text.includes(term));
}

function extractPersons(text: string): string[] {
  const matches = text.match(/\b([A-Z][a-z]{2,}\s+[A-Z][a-z]{2,})\b/g) || [];
  return unique(matches);
}

function extractEntityHints(text: string): string[] {
  const lower = text.toLowerCase();
  const orgs = ORG_HINTS.filter(org => lower.includes(org));
  const tickers = (text.match(/\$[A-Z]{2,6}\b/g) || []).map(t => t.replace('$', ''));
  return unique([...orgs, ...tickers]);
}

export class EntityRelevanceGuard {
  private knowledge = new KnowledgeBase();

  constructor(
    private entityConfidenceThreshold: number,
    private unknownPersonLegalEventPolicy: 'block' | 'review'
  ) {}

  evaluate(context: VerificationContext): GuardDecision {
    const baseText = [context.marketTitle, context.marketDescription || ''].join(' ').trim();
    const lower = baseText.toLowerCase();
    const titleLower = String(context.marketTitle || '').toLowerCase();
    const matchedKeywords = unique(context.ontologyKeywords);
    const explicitKeywordMatch = matchedKeywords.length > 0;

    const extractedPersons = extractPersons(context.marketTitle);
    const extractedEntities = extractEntityHints(baseText);

    const unknownPersons = extractedPersons.filter(person => !this.knowledge.isKnownPerson(person));
    const hasLegalEvent = LEGAL_EVENT_TERMS.some(term => lower.includes(term));

    const knownPersonLinked = extractedPersons.some(person =>
      this.knowledge.personLinkedToAsset(person, context.matchedAssetId)
    );
    const entityLinked = this.knowledge.entityLinkedToAsset(context.marketTitle, context.matchedAssetId);
    const directAssetMention = titleLower.includes(context.matchedAssetName.toLowerCase());
    const knownEntityLinked = knownPersonLinked || entityLinked || directAssetMention;

    const allowlistedMarketType = this.knowledge.isAllowlistedMarketType(baseText);

    if (context.matchedAssetId === 'gaming-evolution') {
      const looksLikeSportsbookRegulation = includesAny(lower, EVOLUTION_BLOCK_TERMS);
      const hasEvolutionSpecificContext = includesAny(lower, EVOLUTION_POSITIVE_TERMS);
      if (looksLikeSportsbookRegulation && !hasEvolutionSpecificContext) {
        return {
          status: 'rejected',
          score: 15,
          reason: 'Blocked sportsbook/operator regulation market: no direct Evolution Gaming catalyst',
          flags: ['weak_gaming_link', 'sportsbook_operator_regulation'],
          matchedKeywords,
          extractedPersons,
          extractedEntities,
          knownEntityLinked: false,
          allowlistedMarketType
        };
      }
    }

    let score = 0.25;
    if (explicitKeywordMatch) score += 0.35;
    if (knownEntityLinked) score += 0.3;
    if (allowlistedMarketType) score += 0.15;
    if (hasLegalEvent && unknownPersons.length > 0) score -= 0.45;
    if (!explicitKeywordMatch) score -= 0.2;
    score = clamp(score, 0, 1);

    if (
      hasLegalEvent &&
      unknownPersons.length > 0 &&
      this.unknownPersonLegalEventPolicy === 'block' &&
      !knownEntityLinked
    ) {
      return {
        status: 'rejected',
        score: Math.round(score * 100),
        reason: `Blocked unknown-person legal event: ${unknownPersons.join(', ')}`,
        flags: ['unknown_person_legal_event', 'no_link'],
        matchedKeywords,
        extractedPersons,
        extractedEntities,
        knownEntityLinked,
        allowlistedMarketType
      };
    }

    if (!explicitKeywordMatch && !knownEntityLinked) {
      return {
        status: 'rejected',
        score: Math.round(score * 100),
        reason: 'Blocked: no explicit ontology keyword match and no known entity-asset link',
        flags: ['no_keyword_match', 'unknown_entity'],
        matchedKeywords,
        extractedPersons,
        extractedEntities,
        knownEntityLinked,
        allowlistedMarketType
      };
    }

    if (score < this.entityConfidenceThreshold) {
      return {
        status: 'needs_review',
        score: Math.round(score * 100),
        reason: 'Entity relevance below configured threshold',
        flags: ['low_entity_confidence'],
        matchedKeywords,
        extractedPersons,
        extractedEntities,
        knownEntityLinked,
        allowlistedMarketType
      };
    }

    return {
      status: 'approved',
      score: Math.round(score * 100),
      reason: knownEntityLinked
        ? 'Known entity-asset relationship validated'
        : 'Approved by explicit ontology keyword match',
      flags: [],
      matchedKeywords,
      extractedPersons,
      extractedEntities,
      knownEntityLinked,
      allowlistedMarketType
    };
  }
}
