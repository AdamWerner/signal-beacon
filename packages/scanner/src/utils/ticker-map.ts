export const ASSET_TO_TICKER: Record<string, string> = {
  'defense-saab': 'SAAB-B.ST',
  'defense-rheinmetall': 'RHM.DE',
  'defense-bae': 'BA.L',
  'defense-lockheed': 'LMT',
  'oil-equinor': 'EQNR',
  'oil-shell': 'SHEL',
  'oil-exxon': 'XOM',
  'oil-conocophillips': 'COP',
  'ai-nvidia': 'NVDA',
  'ai-palantir': 'PLTR',
  'ai-crowdstrike': 'CRWD',
  'ev-tesla': 'TSLA',
  'mining-boliden': 'BOL.ST',
  'mining-freeport': 'FCX',
  'steel-ssab': 'SSAB-B.ST',
  'pharma-novo': 'NVO',
  'shipping-zim': 'ZIM',
  'telecom-ericsson': 'ERIC-B.ST',
  'renewables-vestas': 'VWS.CO',
  'nuclear-sprott': 'SRUUF',
  'crypto-coinbase': 'COIN',
  'gaming-evolution': 'EVO.ST',
  'retail-hm': 'HM-B.ST',
  sp500: 'SPY',
  nasdaq100: 'QQQ',
  omx30: '^OMXS30',
  'tech-spotify': 'SPOT',
  'auto-volvo': 'VOLV-B.ST'
};

export const ASSET_TO_NAME: Record<string, string> = {
  'defense-saab': 'Saab B',
  'defense-rheinmetall': 'Rheinmetall',
  'defense-bae': 'BAE Systems',
  'defense-lockheed': 'Lockheed Martin',
  'oil-equinor': 'Equinor',
  'oil-shell': 'Shell',
  'oil-exxon': 'Exxon Mobil',
  'oil-conocophillips': 'ConocoPhillips',
  'ai-nvidia': 'NVIDIA',
  'ai-palantir': 'Palantir Technologies',
  'ai-crowdstrike': 'CrowdStrike Holdings',
  'ev-tesla': 'Tesla',
  'mining-boliden': 'Boliden',
  'mining-freeport': 'Freeport-McMoRan',
  'steel-ssab': 'SSAB',
  'pharma-novo': 'Novo Nordisk B',
  'shipping-zim': 'ZIM Integrated Shipping Services',
  'telecom-ericsson': 'Ericsson B',
  'renewables-vestas': 'Vestas',
  'nuclear-sprott': 'Sprott Physical Uranium Trust',
  'crypto-coinbase': 'Coinbase Global',
  'gaming-evolution': 'Evolution Gaming',
  'retail-hm': 'H&M',
  sp500: 'S&P 500',
  nasdaq100: 'NASDAQ 100',
  omx30: 'OMX S30',
  'tech-spotify': 'Spotify Technology',
  'auto-volvo': 'Volvo Group'
};

export const ASSET_TO_FINVIZ_TICKER: Record<string, string> = {
  'defense-lockheed': 'LMT',
  'oil-equinor': 'EQNR',
  'oil-shell': 'SHEL',
  'oil-exxon': 'XOM',
  'oil-conocophillips': 'COP',
  'ai-nvidia': 'NVDA',
  'ai-palantir': 'PLTR',
  'ai-crowdstrike': 'CRWD',
  'ev-tesla': 'TSLA',
  'mining-freeport': 'FCX',
  'pharma-novo': 'NVO',
  'shipping-zim': 'ZIM',
  'nuclear-sprott': 'SRUUF',
  'crypto-coinbase': 'COIN',
  'tech-spotify': 'SPOT',
  sp500: 'SPY',
  nasdaq100: 'QQQ'
};

export const ASSET_TO_SHORT_TICKER: Record<string, string> = {
  'defense-saab': 'SAAB',
  'defense-rheinmetall': 'RHM',
  'defense-bae': 'BAE',
  'defense-lockheed': 'LMT',
  'oil-equinor': 'EQNR',
  'oil-shell': 'SHEL',
  'oil-exxon': 'XOM',
  'oil-conocophillips': 'COP',
  'ai-nvidia': 'NVDA',
  'ai-palantir': 'PLTR',
  'ai-crowdstrike': 'CRWD',
  'ev-tesla': 'TSLA',
  'mining-boliden': 'BOL',
  'mining-freeport': 'FCX',
  'steel-ssab': 'SSAB',
  'pharma-novo': 'NVO',
  'shipping-zim': 'ZIM',
  'telecom-ericsson': 'ERIC',
  'renewables-vestas': 'VWS',
  'nuclear-sprott': 'SRUUF',
  'crypto-coinbase': 'COIN',
  'gaming-evolution': 'EVO',
  'retail-hm': 'HM',
  sp500: 'SPY',
  nasdaq100: 'QQQ',
  omx30: 'OMXS30',
  'tech-spotify': 'SPOT',
  'auto-volvo': 'VOLVO'
};

export const FINVIZ_TICKER_TO_ASSET = Object.fromEntries(
  Object.entries(ASSET_TO_FINVIZ_TICKER).map(([assetId, ticker]) => [ticker, assetId])
) as Record<string, string>;

export function getAssetTicker(assetId: string): string | null {
  return ASSET_TO_TICKER[assetId] || null;
}

export function getFinvizTicker(assetId: string): string | null {
  return ASSET_TO_FINVIZ_TICKER[assetId] || null;
}

export function getShortTicker(assetId: string, fallbackName?: string): string {
  return ASSET_TO_SHORT_TICKER[assetId] || fallbackName || assetId.toUpperCase();
}

export function getAssetDisplayName(assetId: string): string {
  return ASSET_TO_NAME[assetId] || assetId;
}
