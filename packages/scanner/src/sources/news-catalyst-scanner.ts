import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SourceCatalyst } from './types.js';
import { getAssetDisplayName } from '../utils/ticker-map.js';
import { parseDbTimestampMs } from '../utils/time.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOOKBACK_HOURS = 3;
const MIN_SOURCES_FOR_CATALYST = 2; // Need 2+ independent sources mentioning the same asset
const MIN_SOURCES_FOR_HIGH_URGENCY = 4;

const BULLISH_KEYWORDS = /\b(upgrade|beat|approval|contract|surge|soar|record|strong|growth|win|order|launch|partnership|buyback|raises|rally|gains|jump|breakout)\b/i;
const BEARISH_KEYWORDS = /\b(downgrade|miss|lawsuit|probe|crash|plunge|collapse|weak|risk|fear|warning|slump|loss|decline|cut|drop|fail|threat|crisis|strike|war|disruption|shortage|sanction|embargo)\b/i;
const BREAKING_KEYWORDS = /\b(breaking|urgent|alert|flash|just in|developing)\b/i;

const BULLISH_SV = /\b(uppg[aå]ng|vinnare|rekord|stark|tillv[aä]xt|vinst|h[öo]j|order|kontrakt|genombrott)\b/i;
const BEARISH_SV = /\b(f[öo]rlorare|b[öo]rsf[öo]rlorare|nedg[aå]ng|tapp|varning|f[öo]rlust|ras|svag|kris|hot)\b/i;

interface OntologyAsset {
  id: string;
  name: string;
  polymarket_patterns: { keywords: string[]; exclude_keywords?: string[] };
}

function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
}

export class NewsCatalystScanner {
  private assetKeywords: Map<string, { keywords: string[]; excludes: string[] }> = new Map();

  constructor(private db: Database.Database) {
    this.loadOntology();
  }

  private loadOntology(): void {
    try {
      const ontologyPath = join(__dirname, '../../../../data/ontology.json');
      const content = readFileSync(ontologyPath, 'utf-8');
      const ontology: { assets: OntologyAsset[] } = JSON.parse(content);
      for (const asset of ontology.assets) {
        this.assetKeywords.set(asset.id, {
          keywords: asset.polymarket_patterns.keywords.map(k => k.toLowerCase()),
          excludes: (asset.polymarket_patterns.exclude_keywords || []).map(k => k.toLowerCase())
        });
      }
      console.log(`  [news-scanner] loaded ${this.assetKeywords.size} assets from ontology`);
    } catch (err) {
      console.warn(`  [news-scanner] ontology load failed: ${String(err)}`);
    }
  }

  async scan(): Promise<SourceCatalyst[]> {
    const startTime = Date.now();
    console.log(`  [news-scanner] starting scan, looking back ${LOOKBACK_HOURS}h`);
    const catalysts: SourceCatalyst[] = [];

    let rows: Array<{ account_handle: string; tweet_text: string; scraped_at: string }>;
    try {
      rows = this.db.prepare(`
        SELECT account_handle, tweet_text, scraped_at
        FROM tweet_snapshots
        WHERE scraped_at >= datetime('now', '-${LOOKBACK_HOURS} hours')
        ORDER BY scraped_at DESC
        LIMIT 500
      `).all() as Array<{ account_handle: string; tweet_text: string; scraped_at: string }>;
    } catch {
      return [];
    }

    if (rows.length === 0) {
      console.log(`  [news-scanner] 0 rows in last ${LOOKBACK_HOURS}h — tweet_snapshots may be empty`);
      return [];
    }

    for (const [assetId, config] of this.assetKeywords) {
      const matchingRows: Array<{
        source: string;
        text: string;
        timestamp: string;
        direction: 'bull' | 'bear' | 'mixed';
      }> = [];
      const seenSources = new Set<string>();

      for (const row of rows) {
        const textLower = row.tweet_text.toLowerCase();

        if (config.excludes.some(ex => containsTerm(textLower, ex))) continue;
        if (!config.keywords.some(kw => containsTerm(textLower, kw))) continue;
        if (seenSources.has(row.account_handle)) continue;
        seenSources.add(row.account_handle);

        const bullish = BULLISH_KEYWORDS.test(textLower) || BULLISH_SV.test(textLower);
        const bearish = BEARISH_KEYWORDS.test(textLower) || BEARISH_SV.test(textLower);
        const direction: 'bull' | 'bear' | 'mixed' = bullish && !bearish
          ? 'bull'
          : bearish && !bullish
            ? 'bear'
            : 'mixed';

        matchingRows.push({
          source: row.account_handle,
          text: row.tweet_text,
          timestamp: row.scraped_at,
          direction
        });
      }

      if (matchingRows.length < MIN_SOURCES_FOR_CATALYST) continue;

      const bullCount = matchingRows.filter(r => r.direction === 'bull').length;
      const bearCount = matchingRows.filter(r => r.direction === 'bear').length;
      const mixedCount = matchingRows.filter(r => r.direction === 'mixed').length;

      let direction: 'bull' | 'bear' | 'neutral';
      if (bullCount > bearCount + mixedCount) {
        direction = 'bull';
      } else if (bearCount > bullCount + mixedCount) {
        direction = 'bear';
      } else {
        direction = 'neutral';
      }

      if (direction === 'neutral' && matchingRows.length < MIN_SOURCES_FOR_HIGH_URGENCY) continue;
      if (direction === 'neutral') {
        direction = bullCount >= bearCount ? 'bull' : 'bear';
      }

      const isBreaking = matchingRows.some(r => BREAKING_KEYWORDS.test(r.text));
      const urgency = matchingRows.length >= MIN_SOURCES_FOR_HIGH_URGENCY || isBreaking
        ? 'high'
        : 'medium';
      const leadHeadline = matchingRows[0];

      catalysts.push({
        sourceType: 'rss_news', // Maps to 'news' family in convergence engine — not price-action
        sourceKey: `rss_news:${assetId}:${direction}:${new Date().toISOString().slice(0, 13)}`,
        ticker: '',
        assetId,
        assetName: getAssetDisplayName(assetId),
        title: `${matchingRows.length} news sources report on ${getAssetDisplayName(assetId)}`,
        body: leadHeadline.text.slice(0, 200),
        directionHint: direction,
        urgency,
        // Convert SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, no suffix) to a proper ISO string
        // so downstream Date.parse calls always get unambiguous UTC timestamps.
        timestamp: new Date(parseDbTimestampMs(leadHeadline.timestamp) || Date.now()).toISOString(),
        sourceWeight: Math.min(1.3, 1 + matchingRows.length * 0.05),
        metadata: {
          sourceCount: matchingRows.length,          // distinct RSS handles — used by RSS-burst carve-out
          sources: matchingRows.map(r => r.source).slice(0, 10),
          totalBoost: matchingRows.length >= 4 ? 8 : matchingRows.length >= 3 ? 5 : 3,
          isBreaking
        }
      });
    }

    console.log(`  [news-scanner] complete in ${Date.now() - startTime}ms — ${catalysts.length} catalysts from ${rows.length} rows`);
    return catalysts;
  }
}
