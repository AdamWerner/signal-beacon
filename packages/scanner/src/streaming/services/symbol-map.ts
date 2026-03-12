export interface AssetSymbolMapping {
  assetId: string;
  binanceSymbol: string;
  secondVenueSymbol?: string;
}

const DEFAULT_ASSET_TO_SYMBOL: Record<string, AssetSymbolMapping> = {
  'crypto-coinbase': {
    assetId: 'crypto-coinbase',
    binanceSymbol: 'BTCUSDT',
    secondVenueSymbol: 'BTC-USD'
  },
  bitcoin: {
    assetId: 'bitcoin',
    binanceSymbol: 'BTCUSDT',
    secondVenueSymbol: 'BTC-USD'
  },
  ethereum: {
    assetId: 'ethereum',
    binanceSymbol: 'ETHUSDT',
    secondVenueSymbol: 'ETH-USD'
  },
  solana: {
    assetId: 'solana',
    binanceSymbol: 'SOLUSDT',
    secondVenueSymbol: 'SOL-USD'
  }
};

export class StreamingSymbolMap {
  private mapping = new Map<string, AssetSymbolMapping>();

  constructor(overrides?: AssetSymbolMapping[]) {
    Object.values(DEFAULT_ASSET_TO_SYMBOL).forEach(entry => {
      this.mapping.set(entry.assetId, entry);
    });

    (overrides || []).forEach(entry => {
      this.mapping.set(entry.assetId, entry);
    });
  }

  getByAssetId(assetId: string): AssetSymbolMapping | null {
    return this.mapping.get(assetId) ?? null;
  }

  getAllBinanceSymbols(): string[] {
    return [...new Set(Array.from(this.mapping.values()).map(item => item.binanceSymbol))];
  }
}

