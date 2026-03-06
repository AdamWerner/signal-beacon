import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Ontology, OntologyAsset, MatchResult } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type { OntologyAsset };

export class OntologyEngine {
  private ontology: Ontology;

  constructor(ontologyPath?: string) {
    const path = ontologyPath || join(__dirname, '../../../../data/ontology.json');
    const content = readFileSync(path, 'utf-8');
    this.ontology = JSON.parse(content);

    console.log(`Loaded ontology v${this.ontology.version} with ${this.ontology.assets.length} assets`);
  }

  /**
   * Get all assets in the ontology
   */
  getAllAssets(): OntologyAsset[] {
    return this.ontology.assets;
  }

  /**
   * Get a specific asset by ID
   */
  getAsset(id: string): OntologyAsset | undefined {
    return this.ontology.assets.find(asset => asset.id === id);
  }

  /**
   * Match a Polymarket market to assets in the ontology
   */
  matchMarket(
    title: string,
    description: string | null,
    category: string | null
  ): MatchResult[] {
    const titleLower = title.toLowerCase();
    const descLower = (description || '').toLowerCase();
    const categoryLower = (category || '').toLowerCase();
    const combinedText = `${titleLower} ${descLower}`;

    const matches: MatchResult[] = [];

    for (const asset of this.ontology.assets) {
      let score = 0;
      const matchedKeywords: string[] = [];
      let hasTitleKeywordMatch = false;

      // Keyword matching
      for (const keyword of asset.polymarket_patterns.keywords) {
        const keywordLower = keyword.toLowerCase();

        // Title matches score 3x
        if (titleLower.includes(keywordLower)) {
          score += 3;
          matchedKeywords.push(keyword);
          hasTitleKeywordMatch = true;
        }
        // Description matches score 1x
        else if (descLower.includes(keywordLower)) {
          score += 1;
          matchedKeywords.push(keyword);
        }
      }

      // Category matching (bonus 2 points)
      if (categoryLower && asset.polymarket_patterns.categories.some(cat =>
        categoryLower.includes(cat.toLowerCase())
      )) {
        score += 2;
      }

      // Exclude keywords (disqualify if found in title)
      const hasExclude = asset.polymarket_patterns.exclude_keywords.some(exclude =>
        titleLower.includes(exclude.toLowerCase())
      );

      if (hasExclude) {
        continue; // Skip this asset
      }

      // Sacred rule: market title must match at least one keyword.
      if (!hasTitleKeywordMatch) {
        continue;
      }

      if (score > 0) {
        matches.push({
          assetId: asset.id,
          score,
          matchedKeywords
        });
      }
    }

    // Sort by score descending
    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Calculate relevance score (0-1) for a market.
   * REQUIRES at least one keyword match — category-only matches (score==2) are not enough.
   */
  calculateRelevance(matches: MatchResult[]): number {
    if (matches.length === 0) return 0;
    const topMatch = matches[0];

    // Category-only match (no keywords) → reject
    if (topMatch.matchedKeywords.length === 0) return 0;

    const topScore = topMatch.score;
    if (topScore >= 6) return 1.0;
    if (topScore >= 4) return 0.8;
    if (topScore >= 3) return 0.6;  // single title keyword match
    if (topScore >= 1) return 0.4;  // description-only match (borderline)
    return 0;
  }

  /**
   * Get correlation logic for an asset
   */
  getCorrelationLogic(assetId: string) {
    const asset = this.getAsset(assetId);
    return asset?.correlation_logic;
  }
}
