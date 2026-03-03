export interface Ontology {
  version: number;
  assets: OntologyAsset[];
}

export interface OntologyAsset {
  id: string;
  name: string;
  category: string;
  polymarket_patterns: PolymarketPatterns;
  avanza_search: AvanzaSearch;
  correlation_logic: CorrelationLogic;
}

export interface PolymarketPatterns {
  keywords: string[];
  categories: string[];
  exclude_keywords: string[];
}

export interface AvanzaSearch {
  underlying_terms: string[];
  certificate_type: string;
  preferred_issuers: string[];
  preferred_leverage: number[];
}

export interface CorrelationLogic {
  default_polarity: 'direct' | 'inverse';
  explanation: string;
}

export interface MatchResult {
  assetId: string;
  score: number;
  matchedKeywords: string[];
}
