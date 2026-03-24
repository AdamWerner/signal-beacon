type SignalLike = {
  primary_source_family?: string | null;
  whale_detected?: boolean | number | null;
  whale_amount_usd?: number | null;
  reasoning?: string | null;
  catalyst_summary?: string | null;
};

function parseSupportingFamilies(summary: string | null | undefined): number {
  const match = String(summary || '').match(/(\d+)\s+supporting families/i);
  return match ? Number(match[1]) : 0;
}

export function isProxySourceFamily(sourceFamily: string | null | undefined): boolean {
  return new Set([
    'crypto_proxy_market',
    'commodity_proxy_market',
    'asset_proxy_market',
    'swedish_macro_proxy'
  ]).has(String(sourceFamily || ''));
}

export function isWhaleBackedProxy(signal: SignalLike): boolean {
  const whaleAmount = Number(signal.whale_amount_usd || 0);
  return Boolean(signal.whale_detected) && whaleAmount >= 5000;
}

export function hasExternalProxyCorroboration(signal: SignalLike): boolean {
  const reasoning = String(signal.reasoning || '');
  const supportingFamilies = parseSupportingFamilies(signal.catalyst_summary);

  if (supportingFamilies > 0) return true;
  if (/\[news:\+\d+/i.test(reasoning)) return true;
  if (/\[macro:/i.test(reasoning)) return true;
  if (/\[futures:[^\]]*confirms/i.test(reasoning)) return true;

  return false;
}

export function isDashboardEligibleSignal(signal: SignalLike): boolean {
  if (String(signal.primary_source_family || '') !== 'crypto_proxy_market') {
    return true;
  }

  return isWhaleBackedProxy(signal) || hasExternalProxyCorroboration(signal);
}

export function getSignalTradeType(signal: SignalLike): 'proxy' | 'direct' {
  return isProxySourceFamily(signal.primary_source_family) ? 'proxy' : 'direct';
}
