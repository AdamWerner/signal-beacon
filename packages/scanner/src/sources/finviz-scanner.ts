import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import finviz from 'finviz-screener';
import { SignalStore } from '../storage/signal-store.js';
import { FINVIZ_TICKER_TO_ASSET, ASSET_TO_FINVIZ_TICKER, getAssetDisplayName } from '../utils/ticker-map.js';
import { SourceCatalyst } from './types.js';

const FINVIZ_BASE = 'https://finviz.com';
const MAX_REQUESTS_PER_CYCLE = 5;
const MAX_NEWS_QUOTE_REQUESTS = 2;
const CACHE_TTL_MS = 15 * 60 * 1000;
const NEWS_LOOKBACK_MS = 12 * 60 * 60 * 1000;

const BULLISH_NEWS_PATTERN = /\b(upgrade|upgraded|beat|beats|approval|approved|contract|partnership|launch|wins|buyback|raises|raised|record|surge)\b/i;
const BEARISH_NEWS_PATTERN = /\b(downgrade|downgraded|miss|misses|lawsuit|probe|investigation|offering|recall|delay|warning|cuts?|slump|drop)\b/i;
const HIGH_URGENCY_NEWS_PATTERN = /\b(breaking|urgent|probe|investigation|lawsuit|approval|contract|guidance|downgrade|upgrade)\b/i;

type CachedCatalysts = {
  expiresAt: number;
  catalysts: SourceCatalyst[];
};

type FinvizChangeFilter = 'Up 2%' | 'Down 2%';

function hashValue(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(text: string): string {
  return decodeHtml(text.replace(/<[^>]+>/g, ' '));
}

function parseMoney(value: string): number {
  const normalized = value.replace(/[$,\s]/g, '').toUpperCase();
  if (!normalized) return 0;
  const multiplier = normalized.endsWith('M')
    ? 1_000_000
    : normalized.endsWith('K')
      ? 1_000
      : 1;
  return parseFloat(normalized.replace(/[MK]$/g, '')) * multiplier;
}

function parseNumeric(value: string): number {
  return parseFloat(value.replace(/[,%\s]/g, ''));
}

function parseFinvizTimestamp(raw: string, currentDateLabel: string | null): { iso: string | null; label: string | null } {
  const value = raw.replace(/\s+/g, ' ').trim();
  const now = new Date();

  if (/^\d{1,2}:\d{2}(AM|PM)$/i.test(value)) {
    const baseLabel = currentDateLabel || now.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      year: '2-digit'
    }).replace(',', '');
    const parsed = new Date(`${baseLabel} ${value}`);
    return { iso: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(), label: baseLabel };
  }

  const normalized = value
    .replace(/^Today\s+/i, `${now.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: '2-digit' })} `)
    .replace(/^Yesterday\s+/i, `${new Date(now.getTime() - 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: '2-digit' })} `)
    .replace(/'/g, '');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return { iso: null, label: currentDateLabel };
  }

  const nextLabel = parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: '2-digit'
  });
  return { iso: parsed.toISOString(), label: nextLabel };
}

function inferNewsDirection(title: string): 'bull' | 'bear' | 'neutral' {
  if (BULLISH_NEWS_PATTERN.test(title)) return 'bull';
  if (BEARISH_NEWS_PATTERN.test(title)) return 'bear';
  return 'neutral';
}

function inferUrgency(title: string): 'high' | 'medium' | 'low' {
  if (HIGH_URGENCY_NEWS_PATTERN.test(title)) return 'high';
  if (/\b(analyst|coverage|conference|interview)\b/i.test(title)) return 'low';
  return 'medium';
}

export class FinvizScanner {
  private quoteCache = new Map<string, CachedCatalysts>();
  private volumeCache: CachedCatalysts | null = null;
  private insiderCache: CachedCatalysts | null = null;
  private rotationOffset = 0;
  private volumeScanDisabledUntil = 0;

  constructor(
    private db?: Database.Database,
    private signalStore?: SignalStore
  ) {}

  async scan(prioritizedAssetIds: string[] = []): Promise<SourceCatalyst[]> {
    const catalysts: SourceCatalyst[] = [];
    let requestsRemaining = MAX_REQUESTS_PER_CYCLE;

    const volumeCatalysts = await this.getVolumeCatalysts();
    catalysts.push(...volumeCatalysts.catalysts);
    requestsRemaining -= volumeCatalysts.requestsUsed;

    const insiderCatalysts = await this.getInsiderCatalysts();
    catalysts.push(...insiderCatalysts.catalysts);
    requestsRemaining -= insiderCatalysts.requestsUsed;

    const assetsForNews = this.selectAssetsForNews(prioritizedAssetIds).slice(0, Math.max(0, Math.min(MAX_NEWS_QUOTE_REQUESTS, requestsRemaining)));
    for (const assetId of assetsForNews) {
      const newsResult = await this.getNewsCatalysts(assetId);
      catalysts.push(...newsResult.catalysts);
      requestsRemaining -= newsResult.requestsUsed;
      if (requestsRemaining <= 0) break;
    }

    const deduped = new Map<string, SourceCatalyst>();
    for (const catalyst of catalysts) {
      deduped.set(catalyst.sourceKey, catalyst);
    }
    const results = Array.from(deduped.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    this.persistCatalysts(results);
    return results;
  }

  private persistCatalysts(catalysts: SourceCatalyst[]): void {
    if (!this.db || catalysts.length === 0) return;

    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO finviz_catalysts (
          ticker, asset_id, catalyst_type, title, direction_hint, urgency, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const catalyst of catalysts) {
        stmt.run(
          catalyst.ticker,
          catalyst.assetId,
          catalyst.sourceType,
          catalyst.title,
          catalyst.directionHint,
          catalyst.urgency,
          catalyst.timestamp
        );
      }
    } catch (error) {
      if (!/finviz_catalysts/i.test(String(error))) {
        console.warn(`[finviz] catalyst persistence failed: ${String(error)}`);
      }
    }
  }

  private selectAssetsForNews(prioritizedAssetIds: string[]): string[] {
    const recentAssetIds = this.signalStore
      ? this.signalStore.findFiltered({ hours: 24, limit: 25 }).map(signal => signal.matched_asset_id)
      : [];

    const supported = Object.keys(ASSET_TO_FINVIZ_TICKER);
    const ordered = [...new Set([
      ...prioritizedAssetIds,
      ...recentAssetIds,
      ...supported.slice(this.rotationOffset),
      ...supported.slice(0, this.rotationOffset)
    ])].filter(assetId => Boolean(ASSET_TO_FINVIZ_TICKER[assetId]));

    this.rotationOffset = (this.rotationOffset + MAX_NEWS_QUOTE_REQUESTS) % Math.max(1, supported.length);
    return ordered;
  }

  private async getNewsCatalysts(assetId: string): Promise<{ catalysts: SourceCatalyst[]; requestsUsed: number }> {
    const ticker = ASSET_TO_FINVIZ_TICKER[assetId];
    if (!ticker) return { catalysts: [], requestsUsed: 0 };

    const cached = this.quoteCache.get(assetId);
    if (cached && cached.expiresAt > Date.now()) {
      return { catalysts: cached.catalysts, requestsUsed: 0 };
    }

    try {
      const response = await fetch(`${FINVIZ_BASE}/quote.ashx?t=${encodeURIComponent(ticker)}&p=d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (PolySignal)' }
      });
      const html = await response.text();
      const catalysts = this.parseNewsTable(html, assetId, ticker);
      this.quoteCache.set(assetId, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        catalysts
      });
      return { catalysts, requestsUsed: 1 };
    } catch (error) {
      console.warn(`[finviz] quote scrape failed for ${ticker}: ${String(error)}`);
      return { catalysts: [], requestsUsed: 1 };
    }
  }

  private parseNewsTable(html: string, assetId: string, ticker: string): SourceCatalyst[] {
    const assetName = getAssetDisplayName(assetId);
    const tableMatch = html.match(/<table[^>]*id="news-table"[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) return [];

    const rows = tableMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const catalysts: SourceCatalyst[] = [];
    let currentDateLabel: string | null = null;

    for (const row of rows.slice(0, 6)) {
      const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
      if (cells.length < 2) continue;

      const timestampCell = cells[0] ?? '';
      const lastCell = cells[cells.length - 1] ?? '';
      const timestampText = stripHtml(timestampCell);
      const titleMatch = row.match(/<a[^>]*class="tab-link-news"[^>]*>([\s\S]*?)<\/a>/i);
      const title = stripHtml(titleMatch?.[1] ?? lastCell);
      if (!title) continue;

      const parsedTime = parseFinvizTimestamp(timestampText, currentDateLabel);
      currentDateLabel = parsedTime.label;
      if (!parsedTime.iso) continue;
      if ((Date.now() - Date.parse(parsedTime.iso)) > NEWS_LOOKBACK_MS) continue;

      const directionHint = inferNewsDirection(title);
      const urgency = inferUrgency(title);
      catalysts.push({
        sourceType: 'finviz_news',
        sourceKey: `finviz-news:${ticker}:${hashValue(title)}`,
        ticker,
        assetId,
        assetName,
        title,
        body: `FinViz news for ${ticker}`,
        directionHint,
        urgency,
        timestamp: parsedTime.iso,
        metadata: {
          timestampText
        }
      });
    }

    return catalysts;
  }

  private async getInsiderCatalysts(): Promise<{ catalysts: SourceCatalyst[]; requestsUsed: number }> {
    if (this.insiderCache && this.insiderCache.expiresAt > Date.now()) {
      return { catalysts: this.insiderCache.catalysts, requestsUsed: 0 };
    }

    try {
      const response = await fetch(`${FINVIZ_BASE}/insidertrading.ashx`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (PolySignal)' }
      });
      const html = await response.text();
      const catalysts = this.parseInsiderTable(html);
      this.insiderCache = {
        expiresAt: Date.now() + CACHE_TTL_MS,
        catalysts
      };
      return { catalysts, requestsUsed: 1 };
    } catch (error) {
      console.warn(`[finviz] insider scrape failed: ${String(error)}`);
      return { catalysts: [], requestsUsed: 1 };
    }
  }

  private parseInsiderTable(html: string): SourceCatalyst[] {
    const tableMatch = html.match(/<table[^>]*id="insider-table"[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) return [];

    const rows = tableMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const catalysts: SourceCatalyst[] = [];

    for (const row of rows) {
      const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
      if (cells.length < 10) continue;

      const ticker = stripHtml(cells[0] ?? '').toUpperCase();
      const assetId = FINVIZ_TICKER_TO_ASSET[ticker];
      if (!assetId) continue;

      const owner = stripHtml(cells[1] ?? '');
      const relationship = stripHtml(cells[2] ?? '');
      const dateText = stripHtml(cells[3] ?? '');
      const transaction = stripHtml(cells[4] ?? '');
      const valueUsd = parseMoney(stripHtml(cells[7] ?? ''));
      const parsedDate = new Date(dateText.replace(/'/g, '20'));
      const timestamp = Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();

      if (/purchase/i.test(transaction) && valueUsd >= 100_000) {
        catalysts.push({
          sourceType: 'finviz_insider',
          sourceKey: `finviz-insider:${ticker}:${hashValue(`${owner}:${dateText}:${transaction}:${valueUsd}`)}`,
          ticker,
          assetId,
          assetName: getAssetDisplayName(assetId),
          title: `${ticker} insider purchase by ${owner}`,
          body: `${relationship} ${transaction} $${Math.round(valueUsd).toLocaleString()}`,
          directionHint: 'bull',
          urgency: 'high',
          timestamp,
          metadata: { owner, relationship, transaction, valueUsd }
        });
      }

      if (/sale/i.test(transaction) && /ceo|chief executive officer|cfo|chief financial officer/i.test(relationship) && valueUsd >= 500_000) {
        catalysts.push({
          sourceType: 'finviz_insider',
          sourceKey: `finviz-insider:${ticker}:${hashValue(`${owner}:${dateText}:${transaction}:${valueUsd}`)}`,
          ticker,
          assetId,
          assetName: getAssetDisplayName(assetId),
          title: `${ticker} executive insider sale by ${owner}`,
          body: `${relationship} ${transaction} $${Math.round(valueUsd).toLocaleString()}`,
          directionHint: 'bear',
          urgency: 'medium',
          timestamp,
          metadata: { owner, relationship, transaction, valueUsd }
        });
      }
    }

    return catalysts;
  }

  private async getVolumeCatalysts(): Promise<{ catalysts: SourceCatalyst[]; requestsUsed: number }> {
    if (this.volumeScanDisabledUntil > Date.now()) {
      return { catalysts: [], requestsUsed: 0 };
    }

    if (this.volumeCache && this.volumeCache.expiresAt > Date.now()) {
      return { catalysts: this.volumeCache.catalysts, requestsUsed: 0 };
    }

    const catalysts: SourceCatalyst[] = [];
    let requestsUsed = 0;
    const screenerOptions = { pageLimit: 1, requestTimeout: 1500 };
    const runScan = async (direction: 'bull' | 'bear', changeFilter: FinvizChangeFilter) => {
      try {
        const tickers = await finviz(screenerOptions)
          .relativeVolume('Over 2')
          .change(changeFilter)
          .scan();
        requestsUsed += 1;
        for (const ticker of tickers.slice(0, 20)) {
          const assetId = FINVIZ_TICKER_TO_ASSET[String(ticker).toUpperCase()];
          if (!assetId) continue;
          catalysts.push({
            sourceType: 'finviz_volume',
            sourceKey: `finviz-volume:${ticker}:${direction}:${new Date().toISOString().slice(0, 13)}`,
            ticker: String(ticker).toUpperCase(),
            assetId,
            assetName: getAssetDisplayName(assetId),
            title: `${ticker} unusual volume ${direction === 'bull' ? 'breakout' : 'breakdown'}`,
            body: `FinViz relative volume > 2x with ${changeFilter} move`,
            directionHint: direction,
            urgency: 'high',
            timestamp: new Date().toISOString(),
            metadata: {
              relativeVolume: '>2',
              changeFilter
            }
          });
        }
      } catch (error) {
        requestsUsed += 1;
        const message = String(error);
        if (/403/i.test(message)) {
          this.volumeScanDisabledUntil = Date.now() + CACHE_TTL_MS;
          console.warn(`[finviz] volume scan blocked by FinViz (${changeFilter}); cooling down for 15m`);
        } else {
          console.warn(`[finviz] volume scan failed (${changeFilter}): ${message}`);
        }
      }
    };

    await runScan('bull', 'Up 2%');
    await runScan('bear', 'Down 2%');

    this.volumeCache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      catalysts
    };

    return { catalysts, requestsUsed };
  }
}
