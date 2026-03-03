export interface GammaMarket {
  id: string;
  condition_id: string;
  question: string;
  slug: string;
  description?: string;
  category?: string;
  end_date_iso?: string;
  active: boolean;
  closed: boolean;
  volume: string;
  volume_24hr?: string;
  liquidity?: string;
  outcomes: string[];
  outcomePrices: string[];
  tags?: string[];
}

export interface GammaMarketsResponse {
  data: GammaMarket[];
  count: number;
  limit: number;
  offset: number;
}

export interface CLOBMarket {
  condition_id: string;
  token_id: string;
  price: string;
  volume_24h?: string;
}

export interface CLOBPricesResponse {
  [tokenId: string]: {
    price: string;
    outcome: string;
  };
}

export interface Trade {
  id: string;
  market_id: string;
  asset_id: string;
  side: 'YES' | 'NO';
  size: string;
  price: string;
  timestamp: number;
  maker: string;
  taker: string;
}

export interface TradesResponse {
  data: Trade[];
  count: number;
}
