export const ASSET_TO_YAHOO_SYMBOL: Record<string, string> = {
  'defense-saab': 'SAAB-B.ST',
  'steel-ssab': 'SSAB-A.ST',
  'mining-boliden': 'BOL.ST',
  'telecom-ericsson': 'ERIC-B.ST',
  'gaming-evolution': 'EVO.ST',
  'retail-hm': 'HM-B.ST',
  'auto-volvo': 'VOLV-B.ST',
  'tech-spotify': 'SPOT',
  'omx30': '^OMXS30',

  'defense-lockheed': 'LMT',
  'defense-rheinmetall': 'RNMBY',
  'defense-bae': 'BAESY',
  'oil-equinor': 'EQNR',
  'oil-conocophillips': 'COP',
  'oil-shell': 'SHEL',
  'oil-exxon': 'XOM',
  'ai-nvidia': 'NVDA',
  'ai-palantir': 'PLTR',
  'ai-crowdstrike': 'CRWD',
  'ev-tesla': 'TSLA',
  'mining-freeport': 'FCX',
  'pharma-novo': 'NVO',
  'shipping-zim': 'ZIM',
  'renewables-vestas': 'VWDRY',
  'nuclear-sprott': 'SRUUF',
  'crypto-coinbase': 'COIN',
  'sp500': '^GSPC',
  'nasdaq100': '^NDX'
};

export function getYahooSymbol(assetId: string): string | null {
  return ASSET_TO_YAHOO_SYMBOL[assetId] || null;
}
