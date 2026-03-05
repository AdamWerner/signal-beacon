import { GammaMarket, Trade } from './types.js';
import { logger } from '../utils/logger.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const DATA_API_BASE = 'https://data-api.polymarket.com';
const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export class PolymarketClient {
  private pageDelayMs: number;

  constructor() {
    this.pageDelayMs = Math.max(50, parseInt(process.env.POLY_PAGE_DELAY_MS || '200', 10));
  }

  /**
   * Fetch markets from Gamma API with pagination
   */
  async fetchMarkets(
    active = true,
    closed = false,
    limit = 100,
    offset = 0
  ): Promise<GammaMarket[]> {
    const url = new URL(`${GAMMA_API_BASE}/markets`);
    url.searchParams.set('active', String(active));
    url.searchParams.set('closed', String(closed));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    try {
      const response = await fetchWithTimeout(url.toString());
      if (!response.ok) {
        throw new Error(`Gamma API error: ${response.statusText}`);
      }
      return await response.json() as GammaMarket[];
    } catch (error) {
      logger.error('Failed to fetch markets from Gamma API', { error: String(error) });
      return [];
    }
  }

  /**
   * Fetch all markets with automatic pagination
   */
  async fetchAllMarkets(active = true, closed = false): Promise<GammaMarket[]> {
    const allMarkets: GammaMarket[] = [];
    let offset = 0;
    const limit = 100;
    let pages = 0;

    while (true) {
      const markets = await this.fetchMarkets(active, closed, limit, offset);
      pages += 1;

      if (markets.length === 0) {
        break;
      }

      // Filter out malformed entries before accumulating
      const valid = markets.filter(m => m.conditionId && m.slug && m.question);
      allMarkets.push(...valid);
      offset += limit;

      if (pages % 10 === 0) {
        logger.info('Gamma pagination progress', { pages, fetched: allMarkets.length });
      }

      await this.delay(this.pageDelayMs);

      if (markets.length < limit) {
        break;
      }
    }

    return allMarkets;
  }

  /**
   * Fetch a single market by its Gamma numeric id (e.g. "531202").
   * GET /markets/{id} returns 200; condition_id as path/query does not work.
   */
  async fetchMarket(gammaId: string): Promise<GammaMarket | null> {
    try {
      const response = await fetchWithTimeout(`${GAMMA_API_BASE}/markets/${gammaId}`);
      if (!response.ok) {
        return null;
      }
      return await response.json() as GammaMarket;
    } catch (error) {
      logger.error('Failed to fetch market', { id: gammaId, error: String(error) });
      return null;
    }
  }

  /**
   * Fetch current yes/no prices using outcomePrices from the Gamma market response.
   * This is simpler and more reliable than the CLOB approach.
   */
  async fetchPrices(conditionId: string): Promise<{ yes: number; no: number } | null> {
    const market = await this.fetchMarket(conditionId);
    if (!market || !market.outcomePrices) {
      return null;
    }

    try {
      // outcomePrices may be a JSON-encoded string or already an array
      const pricesArr: string[] = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices as unknown as string)
        : market.outcomePrices;

      if (!Array.isArray(pricesArr) || pricesArr.length < 2) {
        return null;
      }

      return {
        yes: parseFloat(pricesArr[0]),
        no: parseFloat(pricesArr[1])
      };
    } catch (error) {
      logger.error('Failed to parse outcomePrices', { conditionId, error: String(error) });
      return null;
    }
  }

  /**
   * Fetch recent trades for a market by conditionId
   */
  async fetchTrades(conditionId: string, limit = 100): Promise<Trade[]> {
    try {
      // data-api uses "market" (not "market_id") for the condition_id filter
      const url = `${DATA_API_BASE}/trades?market=${conditionId}&limit=${limit}`;
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        logger.warn('Trades API returned non-OK', { conditionId, status: response.status });
        return [];
      }

      const data = await response.json() as Trade[] | { data?: Trade[] };
      // API may return array directly or { data: [...] }
      return (Array.isArray(data) ? data : (data as { data?: Trade[] }).data ?? []) as Trade[];
    } catch (error) {
      logger.error('Failed to fetch trades', { conditionId, error: String(error) });
      return [];
    }
  }

  /**
   * Search markets by keyword
   */
  async searchMarkets(query: string): Promise<GammaMarket[]> {
    try {
      const url = `${GAMMA_API_BASE}/markets?search=${encodeURIComponent(query)}`;
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        return [];
      }

      return await response.json() as GammaMarket[];
    } catch (error) {
      logger.error('Failed to search markets', { query, error: String(error) });
      return [];
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
