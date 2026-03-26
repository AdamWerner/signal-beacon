import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BREAKING_KEYWORDS = ['breaking', 'urgent', 'alert', 'flash', 'crash', 'surge', 'soars', 'plunges', 'collapses', 'explodes'];
const BULLISH_NEWS_PATTERN = /\b(winner|winners|gain|gains|rise|rises|up|upgrade|upgraded|beat|beats|record|surge|soars|strong|approval|approved|contract|growth|profit|order|uppg[aå]ng|vinnare|rekord|stark|tillv[aä]xt|vinst)\b/i;
const BEARISH_NEWS_PATTERN = /\b(loser|losers|lost|drop|drops|fall|falls|decline|declines|down|downgrade|downgraded|warning|lawsuit|probe|investigation|miss|misses|weak|risk|fear|crash|loss|f[öo]rlorare|b[öo]rsf[öo]rlorare|tapp|nedg[aå]ng|s[aä]nk|varning|f[öo]rlust|ras)\b/i;

export interface NewsBoostResult {
  boost: number;
  sourceCount: number;
  matchedSources: string[];
}

export interface NewsEvidenceItem {
  accountHandle: string;
  text: string;
  timestamp: string;
  matchedTerms: string[];
  weight: number;
}

interface OntologyAsset {
  id: string;
  name: string;
  polymarket_patterns: { keywords: string[] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsTerm(text: string, term: string): boolean {
  const pattern = escapeRegExp(term.trim().toLowerCase()).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, 'i').test(text);
}

function inferNewsDirection(text: string): 'bull' | 'bear' | 'mixed' {
  const bullish = BULLISH_NEWS_PATTERN.test(text);
  const bearish = BEARISH_NEWS_PATTERN.test(text);
  if (bullish && !bearish) return 'bull';
  if (bearish && !bullish) return 'bear';
  return 'mixed';
}

function getRecencyWeight(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 0.25;
  const ageHours = (Date.now() - parsed) / (60 * 60 * 1000);
  if (ageHours <= 1) return 1;
  if (ageHours <= 3) return 0.5;
  if (ageHours <= 6) return 0.25;
  return 0;
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
  getBoostForSignal(assetId: string, direction: 'bull' | 'bear', hours = 6): NewsBoostResult {
    const keywords = this.keywordMap.get(assetId) ?? [];
    const nameTokens = this.nameMap.get(assetId) ?? [];
    const allTerms = [...new Set([...keywords, ...nameTokens])];

    if (allTerms.length === 0) {
      return { boost: 0, sourceCount: 0, matchedSources: [] };
    }

    let rows: { account_handle: string; tweet_text: string; scraped_at: string }[];
    try {
      rows = this.db.prepare(`
        SELECT account_handle, tweet_text, scraped_at
        FROM tweet_snapshots
        WHERE scraped_at >= datetime('now', '-' || ? || ' hours')
        ORDER BY scraped_at DESC
        LIMIT 500
      `).all(hours) as { account_handle: string; tweet_text: string; scraped_at: string }[];
    } catch {
      return { boost: 0, sourceCount: 0, matchedSources: [] };
    }

    const matchedSources = new Set<string>();
    const sourceWeights = new Map<string, number>();
    let hasBreaking = false;

    for (const row of rows) {
      const text = row.tweet_text.toLowerCase();
      const matches = allTerms.some(term => containsTerm(text, term));
      if (!matches) continue;

      const rowDirection = inferNewsDirection(text);
      if (rowDirection !== 'mixed' && rowDirection !== direction) {
        continue;
      }

      matchedSources.add(row.account_handle);
      const recencyWeight = getRecencyWeight(row.scraped_at);
      sourceWeights.set(
        row.account_handle,
        Math.max(sourceWeights.get(row.account_handle) || 0, recencyWeight)
      );

      if (!hasBreaking && BREAKING_KEYWORDS.some(k => text.includes(k))) {
        hasBreaking = true;
      }
    }

    const n = matchedSources.size;
    const weightedSources = Array.from(sourceWeights.values()).reduce((sum, value) => sum + value, 0);
    let boost = 0;

    if (weightedSources >= 3.5) boost = 10;
    else if (weightedSources >= 2) boost = 6;
    else if (weightedSources >= 1) boost = 3;

    if (hasBreaking && weightedSources >= 1.5) boost += 3;
    boost = Math.min(boost, 15);

    return {
      boost,
      sourceCount: n,
      matchedSources: Array.from(matchedSources)
    };
  }

  getEvidenceForAsset(assetId: string, hours = 6, limit = 5, direction?: 'bull' | 'bear'): NewsEvidenceItem[] {
    const keywords = this.keywordMap.get(assetId) ?? [];
    const nameTokens = this.nameMap.get(assetId) ?? [];
    const allTerms = [...new Set([...keywords, ...nameTokens])];
    if (allTerms.length === 0) return [];

    let rows: Array<{
      account_handle: string;
      tweet_text: string;
      scraped_at: string;
      weight: number;
    }> = [];

    try {
      rows = this.db.prepare(`
        SELECT ts.account_handle, ts.tweet_text, ts.scraped_at, COALESCE(ta.weight, 1.0) as weight
        FROM tweet_snapshots ts
        LEFT JOIN tweet_accounts ta ON ta.handle = ts.account_handle
        WHERE ts.scraped_at >= datetime('now', '-' || ? || ' hours')
        ORDER BY ts.scraped_at DESC
        LIMIT 500
      `).all(hours) as Array<{
        account_handle: string;
        tweet_text: string;
        scraped_at: string;
        weight: number;
      }>;
    } catch {
      return [];
    }

    const bySource = new Map<string, NewsEvidenceItem>();

    for (const row of rows) {
      const text = row.tweet_text.toLowerCase();
      const matchedTerms = allTerms.filter(term => containsTerm(text, term));
      if (matchedTerms.length === 0) continue;
      const rowDirection = inferNewsDirection(text);
      if (direction && rowDirection !== 'mixed' && rowDirection !== direction) {
        continue;
      }

      const existing = bySource.get(row.account_handle);
      if (!existing) {
        bySource.set(row.account_handle, {
          accountHandle: row.account_handle,
          text: row.tweet_text,
          timestamp: row.scraped_at,
          matchedTerms,
          weight: row.weight || 1
        });
      }
      if (bySource.size >= limit) break;
    }

    return [...bySource.values()];
  }
}
