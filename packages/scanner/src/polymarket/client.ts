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

    while (true) {
      const markets = await this.fetchMarkets(active, closed, limit, offset);

      if (markets.length === 0) {
        break;
      }

      allMarkets.push(...markets);
      offset += limit;

      await this.delay(500);

      if (markets.length < limit) {
        break;
      }
    }

    return allMarkets;
  }

  /**
   * Fetch a single market by slug or condition_id
   */
  async fetchMarket(slugOrConditionId: string): Promise<GammaMarket | null> {
    try {
      const response = await fetchWithTimeout(`${GAMMA_API_BASE}/markets/${slugOrConditionId}`);
      if (!response.ok) {
        return null;
      }
      return await response.json() as GammaMarket;
    } catch (error) {
      logger.error('Failed to fetch market', { id: slugOrConditionId, error: String(error) });
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
   * Fetch recent trades for a market
   */
  async fetchTrades(marketId: string, limit = 100): Promise<Trade[]> {
    try {
      const url = `${DATA_API_BASE}/trades?market_id=${marketId}&limit=${limit}`;
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        return [];
      }

      return await response.json() as Trade[];
    } catch (error) {
      logger.error('Failed to fetch trades', { marketId, error: String(error) });
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
