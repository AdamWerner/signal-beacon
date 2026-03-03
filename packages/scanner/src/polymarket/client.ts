import { GammaMarketsResponse, GammaMarket, Trade, TradesResponse, CLOBPricesResponse } from './types.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const CLOB_API_BASE = 'https://clob.polymarket.com';
const DATA_API_BASE = 'https://data-api.polymarket.com';

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
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Gamma API error: ${response.statusText}`);
      }

      const data = await response.json() as GammaMarket[];
      return data;
    } catch (error) {
      console.error('Failed to fetch markets from Gamma API:', error);
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

      // Rate limiting
      await this.delay(500);

      if (markets.length < limit) {
        break; // No more pages
      }
    }

    return allMarkets;
  }

  /**
   * Fetch a single market by slug or condition_id
   */
  async fetchMarket(slugOrConditionId: string): Promise<GammaMarket | null> {
    try {
      const response = await fetch(`${GAMMA_API_BASE}/markets/${slugOrConditionId}`);
      if (!response.ok) {
        return null;
      }

      return await response.json() as GammaMarket;
    } catch (error) {
      console.error(`Failed to fetch market ${slugOrConditionId}:`, error);
      return null;
    }
  }

  /**
   * Fetch current prices for a market from CLOB API
   */
  async fetchPrices(conditionId: string): Promise<{ yes: number; no: number } | null> {
    try {
      const response = await fetch(`${CLOB_API_BASE}/prices?condition_id=${conditionId}`);
      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      // Parse prices from response (structure may vary)
      // This is a simplified version - actual structure depends on CLOB API
      const yesPrice = parseFloat(data.yes || data.YES || '0.5');
      const noPrice = parseFloat(data.no || data.NO || '0.5');

      return { yes: yesPrice, no: noPrice };
    } catch (error) {
      console.error(`Failed to fetch prices for ${conditionId}:`, error);
      return null;
    }
  }

  /**
   * Fetch recent trades for a market
   */
  async fetchTrades(marketId: string, limit = 100): Promise<Trade[]> {
    try {
      const url = `${DATA_API_BASE}/trades?market_id=${marketId}&limit=${limit}`;
      const response = await fetch(url);

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as Trade[];
      return data;
    } catch (error) {
      console.error(`Failed to fetch trades for ${marketId}:`, error);
      return [];
    }
  }

  /**
   * Search markets by keyword
   */
  async searchMarkets(query: string): Promise<GammaMarket[]> {
    try {
      const url = `${GAMMA_API_BASE}/markets?search=${encodeURIComponent(query)}`;
      const response = await fetch(url);

      if (!response.ok) {
        return [];
      }

      return await response.json() as GammaMarket[];
    } catch (error) {
      console.error(`Failed to search markets for "${query}":`, error);
      return [];
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
