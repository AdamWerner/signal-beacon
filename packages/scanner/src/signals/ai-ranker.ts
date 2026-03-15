import { Signal } from '../storage/signal-store.js';
import { isNoiseMarketQuestion } from '../polymarket/noise-filter.js';
import { runLocalAiPrompt } from '../utils/local-ai-cli.js';
import { shouldDoAiRanking } from '../utils/ai-budget.js';

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface RankCache {
  rankedIds: string[];
  expiresAt: number;
  signalCount: number;
  includeUnverified: boolean;
}

let cache: RankCache | null = null;

async function callLocalAi(prompt: string, timeoutMs = 60000): Promise<string> {
  const result = await runLocalAiPrompt(prompt, {
    timeoutMs,
    maxBufferBytes: 1024 * 1024,
    usageContext: 'ai-ranking',
    logContext: 'ai-ranking'
  });
  return result.ok ? result.stdout : '';
}

export type RankedSignal = Signal & { also_affects: string[] };

function isVerificationApproved(signal: Signal): boolean {
  if (signal.verification_status !== 'approved') return false;
  return (
    signal.verification_source === 'claude' ||
    signal.verification_source === 'guard' ||
    signal.verification_source === 'guard_allowlist'
  );
}

function isMicroTimeboxMarket(title: string): boolean {
  const normalized = (title || '').toLowerCase();
  if (!normalized) return false;
  if (/\b\d{1,2}:\d{2}\s*(am|pm)\s*-\s*\d{1,2}:\d{2}\s*(am|pm)\s*et\b/i.test(normalized)) {
    return true;
  }
  if (/\b(up|down)\b.+\b(up|down)\b/.test(normalized) && /\b(et|eastern)\b/.test(normalized)) {
    return true;
  }
  return /up or down\s*-\s*.+\bet\b/i.test(normalized);
}

function rankingPenalty(signal: Signal): number {
  let penalty = 0;
  if (isMicroTimeboxMarket(signal.market_title || '')) {
    penalty += 40;
    if (signal.matched_asset_id === 'crypto-coinbase') {
      penalty += 18;
    }
  }

  const absOddsSwing = Math.abs(signal.odds_now - signal.odds_before);
  if (signal.time_window_minutes <= 15 && absOddsSwing >= 0.85) {
    penalty += 20;
  }

  return penalty;
}

function scoreForFallback(signal: Signal): number {
  const judge = signal.requires_judgment ? -10 : 0;
  const verify = isVerificationApproved(signal) ? 8 : -12;
  const base =
    signal.confidence +
    Math.min(Math.abs(signal.delta_pct), 30) +
    (signal.whale_detected ? 10 : 0) +
    judge +
    verify;
  return base - rankingPenalty(signal);
}

/**
 * Deduplicate a raw signal pool:
 *   1. Per market → keep highest-confidence signal per asset
 *   2. Per market → pick ONE best asset, collect others as also_affects
 *   3. Per (asset+direction) → keep highest-confidence across markets
 */
function deduplicateSignals(signals: Signal[]): RankedSignal[] {
  // Step 1: per market, best signal per asset
  const marketAssetGroups = new Map<string, Map<string, Signal>>();
  for (const s of signals) {
    if (!marketAssetGroups.has(s.market_condition_id)) {
      marketAssetGroups.set(s.market_condition_id, new Map());
    }
    const assetMap = marketAssetGroups.get(s.market_condition_id)!;
    const existing = assetMap.get(s.matched_asset_id);
    if (!existing || s.confidence > existing.confidence) {
      assetMap.set(s.matched_asset_id, s);
    }
  }

  // Step 2: per market, pick ONE best asset; others → also_affects
  const marketBest: RankedSignal[] = [];
  for (const [, assetMap] of marketAssetGroups) {
    const assetSignals = Array.from(assetMap.values());
    assetSignals.sort((a, b) =>
      (b.confidence * Math.abs(b.delta_pct)) - (a.confidence * Math.abs(a.delta_pct))
    );
    const best = assetSignals[0];
    const others = assetSignals.slice(1).map(s => s.matched_asset_name);
    marketBest.push({ ...best, also_affects: others });
  }

  // Step 3: per matched_asset_id — keep the single best signal (any direction).
  // Mention the losing direction in also_affects.
  const assetBest = new Map<string, RankedSignal>();
  const assetRunner = new Map<string, RankedSignal>(); // second-best direction

  for (const s of marketBest) {
    const existing = assetBest.get(s.matched_asset_id);
    if (!existing || s.confidence > existing.confidence) {
      if (existing) assetRunner.set(s.matched_asset_id, existing);
      assetBest.set(s.matched_asset_id, s);
    } else {
      const runner = assetRunner.get(s.matched_asset_id);
      if (!runner || s.confidence > runner.confidence) {
        assetRunner.set(s.matched_asset_id, s);
      }
    }
  }

  // Merge runner-up direction into also_affects of the winner
  const result: RankedSignal[] = [];
  for (const [assetId, best] of assetBest) {
    const runner = assetRunner.get(assetId);
    const alsoAffects = [...best.also_affects];
    if (runner) {
      const dir = runner.suggested_action.toLowerCase().includes('bull') ? 'BULL' : 'BEAR';
      alsoAffects.push(`${dir} ${runner.matched_asset_name} (alt direction)`);
    }
    result.push({ ...best, also_affects: alsoAffects });
  }

  return result;
}

function buildRankPrompt(signals: RankedSignal[]): string {
  const items = signals.map((s, i) => ({
    index: i,
    id: s.id,
    asset: s.matched_asset_name,
    action: s.suggested_action,
    market: s.market_title.substring(0, 80),
    confidence: s.confidence,
    delta_pct: s.delta_pct,
    whale: s.whale_detected,
    requires_judgment: s.requires_judgment,
    micro_timebox_noise: isMicroTimeboxMarket(s.market_title || '')
  }));

  return `You are a financial signal ranker. Rank these ${signals.length} trading signals by actionability and quality. Prefer high-confidence, large delta moves on well-known assets. Penalize signals that require judgment or have low confidence. Heavily penalize micro_timebox_noise=true and avoid ranking those near the top unless no better alternatives exist. Return ONLY a JSON array of the top 10 signal IDs in ranked order, no explanation, no markdown fences.

Signals:
${JSON.stringify(items, null, 2)}

Respond with ONLY a JSON array of IDs, e.g.: ["id1","id2","id3",...]`;
}

function fallbackRank(signals: RankedSignal[]): RankedSignal[] {
  return [...signals].sort((a, b) => {
    const aScore = scoreForFallback(a);
    const bScore = scoreForFallback(b);
    return bScore - aScore;
  });
}

export function deduplicateSignalsForTopTrades(signals: Signal[]): RankedSignal[] {
  return deduplicateSignals(signals);
}

/**
 * Deduplicate signal pool, then return up to 10 AI-ranked signals.
 * Falls back to confidence-based sorting if Claude is unavailable.
 * Results are cached for 15 minutes.
 */
export async function getTopSignals(
  rawSignals: Signal[],
  options?: { includeUnverified?: boolean }
): Promise<RankedSignal[]> {
  if (rawSignals.length === 0) return [];
  const includeUnverified = options?.includeUnverified ?? false;
  const nonNoisePool = rawSignals.filter(signal => !isNoiseMarketQuestion(signal.market_title || ''));
  const verifiedPool = includeUnverified
    ? nonNoisePool
    : nonNoisePool.filter(signal => isVerificationApproved(signal));
  const deduped = deduplicateSignals(verifiedPool);
  if (deduped.length === 0) return [];

  const now = Date.now();

  // Return cached ranking if still valid and signal count unchanged
  if (
    cache &&
    cache.expiresAt > now &&
    cache.signalCount === deduped.length &&
    cache.includeUnverified === includeUnverified
  ) {
    const idOrder = cache.rankedIds;
    const byId = new Map(deduped.map(s => [s.id, s]));
    const ranked = idOrder.map(id => byId.get(id)).filter((s): s is RankedSignal => s !== undefined);
    const missing = deduped.filter(s => !idOrder.includes(s.id));
    return [...ranked, ...missing].slice(0, 10);
  }

  // Use at most 20 signals as input to Claude
  const candidates = [...deduped]
    .sort((a, b) => scoreForFallback(b) - scoreForFallback(a))
    .slice(0, 20);

  // Skip Claude during dormant mode (nights/weekends)
  if (!shouldDoAiRanking()) {
    console.log('  [ai-budget] Skipping AI ranking (dormant mode)');
    return fallbackRank(candidates).slice(0, 10);
  }

  // Skip Claude when no high-quality candidates — saves tokens on low-signal cycles
  const highQuality = candidates.filter(s => s.confidence >= 50).length;
  if (highQuality < 3) {
    console.log(`Skipping AI ranking — only ${highQuality} high-quality candidates (need 3+)`);
    return fallbackRank(candidates).slice(0, 10);
  }

  const prompt = buildRankPrompt(candidates);
  const raw = await callLocalAi(prompt);

  if (raw) {
    try {
      const cleaned = raw.replace(/```[a-z]*\n?/gi, '').trim();
      const ids: string[] = JSON.parse(cleaned);
      if (Array.isArray(ids) && ids.length > 0) {
        cache = {
          rankedIds: ids,
          expiresAt: now + CACHE_TTL_MS,
          signalCount: deduped.length,
          includeUnverified
        };
        const byId = new Map(candidates.map(s => [s.id, s]));
        return ids.map(id => byId.get(id)).filter((s): s is RankedSignal => s !== undefined).slice(0, 10);
      }
    } catch {
      console.error('Failed to parse Claude ranking response:', raw.substring(0, 200));
    }
  }

  console.log('Using fallback confidence-based signal ranking');
  return fallbackRank(candidates).slice(0, 10);
}

/**
 * Generate a 3-sentence AI analysis + rating for a single signal.
 * Returns a plain text string. Caller is responsible for caching.
 */
export async function analyzeSignal(signal: Signal): Promise<string> {
  const isBull = signal.suggested_action.toLowerCase().includes('bull');
  const dir = isBull ? 'BULLISH' : 'BEARISH';
  const deltaSign = signal.delta_pct > 0 ? '+' : '';

  const prompt = `You are a concise financial analyst. A Polymarket prediction market just moved ${deltaSign}${signal.delta_pct.toFixed(1)}% (${(signal.odds_before * 100).toFixed(0)}%→${(signal.odds_now * 100).toFixed(0)}% YES) on the question: "${signal.market_title}".

This move generated a ${dir} signal for ${signal.matched_asset_name} with ${signal.confidence}% confidence.
${signal.whale_detected ? `A whale trade of $${signal.whale_amount_usd?.toLocaleString() ?? 'unknown'} was detected.` : ''}

In exactly 3 sentences: (1) explain WHY this market move affects ${signal.matched_asset_name}, (2) describe the key risk or caveat, (3) give a one-word rating: STRONG / MODERATE / WEAK / AVOID.

Be direct and professional. No markdown.`;

  const result = await callLocalAi(prompt, 45000);
  return result || `${dir} signal on ${signal.matched_asset_name}. Market odds shifted ${deltaSign}${signal.delta_pct.toFixed(1)}% — monitor for follow-through. Rating: MODERATE.`;
}
