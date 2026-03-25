import { getAssetTicker } from '../utils/ticker-map.js';

export function getYahooSymbol(assetId: string): string | null {
  return getAssetTicker(assetId);
}
