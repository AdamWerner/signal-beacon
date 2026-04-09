import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { ASSET_TO_FINVIZ_TICKER, ASSET_TO_TICKER, FINVIZ_TICKER_TO_ASSET, getAssetDisplayName } from '../utils/ticker-map.js';
import { SourceCatalyst } from './types.js';
import { parseDbTimestampMs } from '../utils/time.js';

const HOUSE_TRANSACTIONS_URL = 'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json';
const SENATE_TRANSACTIONS_URL = 'https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 7;
const MAX_SEC_TICKER_QUERIES = 4;

interface CongressionalTradeRecord {
  transaction_date?: string;
  ticker?: string;
  asset_description?: string;
  amount?: string;
  type?: string;
  owner?: string;
  senator?: string;
  representative?: string;
  ptr_link?: string;
}

interface SecSearchHit {
  _source?: {
    display_names?: string[];
    root_forms?: string[];
    file_date?: string;
    form?: string;
    file_type?: string;
  };
}

interface CachedInsiderScan {
  expiresAt: number;
  catalysts: SourceCatalyst[];
}

function hashValue(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function buildTickerToAssetMap(): Record<string, string> {
  const mapping: Record<string, string> = { ...FINVIZ_TICKER_TO_ASSET };
  for (const [assetId, ticker] of Object.entries(ASSET_TO_TICKER)) {
    const normalized = ticker.replace(/\..+$/g, '').replace(/^\^/g, '').toUpperCase();
    if (normalized && !mapping[normalized]) {
      mapping[normalized] = assetId;
    }
  }
  return mapping;
}

function parseAmountRange(raw: string | undefined): number {
  if (!raw) return 0;
  const values = [...raw.matchAll(/\$?([\d,]+)/g)]
    .map(match => Number(match[1].replace(/,/g, '')))
    .filter(value => Number.isFinite(value));

  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  return Math.max(values[0], values[1]);
}

function parseUsDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim();
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  const match = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  const manual = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0);
  return Number.isNaN(manual.getTime()) ? null : manual.toISOString();
}

export class InsiderScanner {
  private cache: CachedInsiderScan | null = null;
  private readonly tickerToAsset = buildTickerToAssetMap();
  private secRotationOffset = 0;

  constructor(private db?: Database.Database) {}

  async scan(prioritizedAssetIds: string[] = []): Promise<SourceCatalyst[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.catalysts;
    }

    const [houseTrades, senateTrades, secCatalysts] = await Promise.all([
      this.fetchCongressionalTrades(HOUSE_TRANSACTIONS_URL, 'house'),
      this.fetchCongressionalTrades(SENATE_TRANSACTIONS_URL, 'senate'),
      this.fetchRecentSecForm4(prioritizedAssetIds)
    ]);

    const catalysts = [
      ...this.buildCongressionalCatalysts([...houseTrades, ...senateTrades]),
      ...secCatalysts
    ];

    this.cache = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      catalysts
    };
    return catalysts;
  }

  private async fetchCongressionalTrades(
    url: string,
    source: 'house' | 'senate'
  ): Promise<Array<CongressionalTradeRecord & { source: string }>> {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PolySignal/1.0)' },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        if (response.status !== 403) {
          console.warn(`[insider] ${source} feed returned ${response.status}`);
        }
        return [];
      }

      const data = await response.json() as CongressionalTradeRecord[];
      return Array.isArray(data)
        ? data.map(record => ({ ...record, source }))
        : [];
    } catch (error) {
      console.warn(`[insider] ${source} feed failed: ${String(error)}`);
      return [];
    }
  }

  private buildCongressionalCatalysts(
    records: Array<CongressionalTradeRecord & { source: string }>
  ): SourceCatalyst[] {
    const lookbackCutoff = Date.now() - (LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const grouped = new Map<string, Array<CongressionalTradeRecord & { source: string; assetId: string; amountUsd: number; timestamp: string }>>();

    for (const record of records) {
      const ticker = String(record.ticker || '').toUpperCase().trim();
      const assetId = this.tickerToAsset[ticker];
      if (!assetId) continue;

      const timestamp = parseUsDate(record.transaction_date);
      if (!timestamp) continue;
      if (parseDbTimestampMs(timestamp) < lookbackCutoff) continue;

      const amountUsd = parseAmountRange(record.amount);
      if (amountUsd <= 0) continue;

      const key = `${assetId}:${ticker}`;
      const bucket = grouped.get(key) || [];
      bucket.push({
        ...record,
        assetId,
        amountUsd,
        timestamp
      });
      grouped.set(key, bucket);

      this.persistInsiderTrade({
        ticker,
        assetId,
        traderName: record.senator || record.representative || record.owner || 'Unknown',
        traderRole: sourceRole(record.source),
        transactionType: record.type || 'Unknown',
        amountUsd,
        transactionDate: timestamp,
        source: record.source
      });
    }

    const catalysts: SourceCatalyst[] = [];
    for (const [key, trades] of grouped.entries()) {
      const [assetId, ticker] = key.split(':');
      const buys = trades.filter(trade => /purchase/i.test(String(trade.type || '')));
      const totalBuyUsd = buys.reduce((sum, trade) => sum + trade.amountUsd, 0);
      const uniqueBuyers = new Set(buys.map(trade => trade.senator || trade.representative || trade.owner || 'Unknown'));

      if (buys.some(trade => trade.amountUsd >= 50_000)) {
        catalysts.push({
          sourceType: 'congressional_trade',
          sourceKey: `congress:${assetId}:${hashValue(buys.map(trade => `${trade.transaction_date}:${trade.amount}`).join('|'))}`,
          ticker,
          assetId,
          assetName: getAssetDisplayName(assetId),
          title: `${ticker} congressional buying interest`,
          body: `${uniqueBuyers.size} lawmaker${uniqueBuyers.size === 1 ? '' : 's'} bought ${ticker} in the last ${LOOKBACK_DAYS}d`,
          directionHint: 'bull',
          urgency: uniqueBuyers.size >= 2 || totalBuyUsd >= 150_000 ? 'medium' : 'low',
          timestamp: buys
            .map(trade => trade.timestamp)
            .sort()
            .at(-1) || new Date().toISOString(),
          sourceWeight: uniqueBuyers.size >= 2 ? 1.1 : 1.0,
          metadata: {
            buyers: Array.from(uniqueBuyers),
            totalBuyUsd,
            tradeCount: buys.length
          }
        });
      }
    }

    return catalysts;
  }

  private async fetchRecentSecForm4(prioritizedAssetIds: string[]): Promise<SourceCatalyst[]> {
    const supported = Object.entries(ASSET_TO_FINVIZ_TICKER)
      .map(([assetId, ticker]) => ({ assetId, ticker }))
      .filter(entry => entry.ticker);
    const ordered = [
      ...prioritizedAssetIds.map(assetId => ({
        assetId,
        ticker: ASSET_TO_FINVIZ_TICKER[assetId]
      })),
      ...supported
    ].filter((entry, index, array) =>
      Boolean(entry.ticker) &&
      array.findIndex(candidate => candidate.assetId === entry.assetId) === index
    );

    const startDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    const subset = ordered.slice(this.secRotationOffset, this.secRotationOffset + MAX_SEC_TICKER_QUERIES);
    this.secRotationOffset = (this.secRotationOffset + MAX_SEC_TICKER_QUERIES) % Math.max(1, ordered.length);

    const catalysts: SourceCatalyst[] = [];
    for (const entry of subset) {
      if (!entry.ticker) continue;
      try {
        const query = encodeURIComponent(`${entry.ticker} "Form 4"`);
        const url = `https://efts.sec.gov/LATEST/search-index?q=${query}&dateRange=custom&startdt=${startDate}&enddt=${endDate}`;
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; PolySignal/1.0)',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
          continue;
        }

        const payload = await response.json() as { hits?: { hits?: SecSearchHit[] } };
        const hits = (payload.hits?.hits || []).filter(hit =>
          hit._source?.root_forms?.includes('4') &&
          hit._source?.display_names?.some(name => name.includes(entry.ticker || ''))
        );

        if (hits.length === 0) continue;

        const latestDate = hits
          .map(hit => hit._source?.file_date)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) || new Date().toISOString().slice(0, 10);

        this.persistInsiderTrade({
          ticker: entry.ticker,
          assetId: entry.assetId,
          traderName: 'SEC Form 4 cluster',
          traderRole: 'insider_filing',
          transactionType: 'Form 4 filing',
          amountUsd: null,
          transactionDate: new Date(latestDate).toISOString(),
          source: 'sec'
        });

        catalysts.push({
          sourceType: 'sec_insider',
          sourceKey: `sec-form4:${entry.assetId}:${latestDate}:${hits.length}`,
          ticker: entry.ticker,
          assetId: entry.assetId,
          assetName: getAssetDisplayName(entry.assetId),
          title: `${entry.ticker} recent Form 4 activity`,
          body: `${hits.length} Form 4 filing${hits.length === 1 ? '' : 's'} in the last ${LOOKBACK_DAYS}d`,
          directionHint: 'neutral',
          urgency: 'low',
          timestamp: new Date(latestDate).toISOString(),
          sourceWeight: 0.98,
          metadata: {
            filings: hits.length,
            latestDate
          }
        });
      } catch {
        // Ignore per-ticker SEC failures. This is confirmation-only.
      }
    }

    return catalysts;
  }

  private persistInsiderTrade(input: {
    ticker: string;
    assetId: string;
    traderName: string;
    traderRole: string;
    transactionType: string;
    amountUsd: number | null;
    transactionDate: string;
    source: string;
  }): void {
    if (!this.db) return;

    try {
      this.db.prepare(`
        INSERT INTO insider_trades (
          ticker, asset_id, trader_name, trader_role, transaction_type, amount_usd, transaction_date, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.ticker,
        input.assetId,
        input.traderName,
        input.traderRole,
        input.transactionType,
        input.amountUsd,
        input.transactionDate,
        input.source
      );
    } catch (error) {
      if (!/insider_trades/i.test(String(error))) {
        console.warn(`[insider] persistence failed for ${input.ticker}: ${String(error)}`);
      }
    }
  }
}

function sourceRole(source: string): string {
  return source === 'house' ? 'house_member' : 'senator';
}
