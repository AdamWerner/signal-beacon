import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BREAKING_KEYWORDS = ['breaking', 'urgent', 'alert', 'flash', 'crash', 'surge', 'soars', 'plunges', 'collapses', 'explodes'];

export interface NewsBoostResult {
  boost: number;
  sourceCount: number;
  matchedSources: string[];
}

interface OntologyAsset {
  id: string;
  name: string;
  polymarket_patterns: { keywords: string[] };
}

export class NewsCorrelator {
  private keywordMap: Map<string, string[]> = new Map();
  private nameMap: Map<string, string[]> = new Map();

  constructor(private db: Database.Database) {
    this.loadOntology();
  }

  private loadOntology(): void {
    try {
      const ontologyPath = join(__dirname, '../../../../data/ontology.json');
      const content = readFileSync(ontologyPath, 'utf-8');
      const ontology: { assets: OntologyAsset[] } = JSON.parse(content);

      for (const asset of ontology.assets) {
        const keywords = asset.polymarket_patterns.keywords.map(k => k.toLowerCase());
        this.keywordMap.set(asset.id, keywords);

        // Also index the asset name itself as a keyword (e.g. "Rheinmetall", "NVIDIA")
        const nameTokens = asset.name.toLowerCase().split(/\s+/).filter(t => t.length > 3);
        this.nameMap.set(asset.id, nameTokens);
      }
    } catch {
      // Non-fatal — correlator will return 0 boost if ontology unreadable.
    }
  }

  /**
   * Count how many distinct news sources (by account_handle) have
   * headlines matching the given asset's keywords in the last `hours` hours.
   * Returns a boost score (0-15) and match metadata.
   */
  getBoostForAsset(assetId: string, hours = 6): NewsBoostResult {
    const keywords = this.keywordMap.get(assetId) ?? [];
    const nameTokens = this.nameMap.get(assetId) ?? [];
    const allTerms = [...new Set([...keywords, ...nameTokens])];

    if (allTerms.length === 0) {
      return { boost: 0, sourceCount: 0, matchedSources: [] };
    }

    let rows: { account_handle: string; tweet_text: string }[];
    try {
      rows = this.db.prepare(`
        SELECT account_handle, tweet_text
        FROM tweet_snapshots
        WHERE scraped_at >= datetime('now', '-' || ? || ' hours')
        ORDER BY scraped_at DESC
        LIMIT 500
      `).all(hours) as { account_handle: string; tweet_text: string }[];
    } catch {
      return { boost: 0, sourceCount: 0, matchedSources: [] };
    }

    const matchedSources = new Set<string>();
    let hasBreaking = false;

    for (const row of rows) {
      const text = row.tweet_text.toLowerCase();
      const matches = allTerms.some(term => text.includes(term));
      if (!matches) continue;

      matchedSources.add(row.account_handle);

      if (!hasBreaking && BREAKING_KEYWORDS.some(k => text.includes(k))) {
        hasBreaking = true;
      }
    }

    const n = matchedSources.size;
    let boost = 0;

    if (n >= 4) boost = 10;
    else if (n === 3) boost = 6;
    else if (n === 2) boost = 3;
    // n <= 1: boost stays 0

    if (hasBreaking && n >= 2) boost += 3;
    boost = Math.min(boost, 15);

    return {
      boost,
      sourceCount: n,
      matchedSources: Array.from(matchedSources)
    };
  }
}
