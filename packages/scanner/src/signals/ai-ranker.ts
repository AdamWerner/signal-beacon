import { execFile } from 'child_process';
import { promisify } from 'util';
import { Signal } from '../storage/signal-store.js';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface RankCache {
  rankedIds: string[];
  expiresAt: number;
  signalCount: number;
}

let cache: RankCache | null = null;

// Common install paths for claude CLI on Windows and Unix
const CLAUDE_CANDIDATES = [
  'claude',
  'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
];

async function callClaude(prompt: string, timeoutMs = 60000): Promise<string> {
  for (const bin of CLAUDE_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(bin, ['-p', prompt], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      });
      return stdout.trim();
    } catch {
      // Try next candidate
    }
  }
  return '';
}

export type RankedSignal = Signal & { also_affects: string[] };

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

  // Step 3: per (asset_id + direction), keep highest-confidence
  const assetDirBest = new Map<string, RankedSignal>();
  for (const s of marketBest) {
    const dir = s.suggested_action.toLowerCase().includes('bull') ? 'bull'
      : s.suggested_action.toLowerCase().includes('bear') ? 'bear' : 'any';
    const key = `${s.matched_asset_id}::${dir}`;
    const existing = assetDirBest.get(key);
    if (!existing || s.confidence > existing.confidence) {
      assetDirBest.set(key, s);
    }
  }

  return Array.from(assetDirBest.values());
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
    requires_judgment: s.requires_judgment
  }));

  return `You are a financial signal ranker. Rank these ${signals.length} trading signals by actionability and quality. Prefer high-confidence, large delta moves on well-known assets. Penalize signals that require judgment or have low confidence. Return ONLY a JSON array of the top 10 signal IDs in ranked order, no explanation, no markdown fences.

Signals:
${JSON.stringify(items, null, 2)}

Respond with ONLY a JSON array of IDs, e.g.: ["id1","id2","id3",...]`;
}

function fallbackRank(signals: RankedSignal[]): RankedSignal[] {
  return [...signals].sort((a, b) => {
    const aJudge = a.requires_judgment ? -10 : 0;
    const bJudge = b.requires_judgment ? -10 : 0;
    const aScore = a.confidence + Math.min(Math.abs(a.delta_pct), 30) + (a.whale_detected ? 10 : 0) + aJudge;
    const bScore = b.confidence + Math.min(Math.abs(b.delta_pct), 30) + (b.whale_detected ? 10 : 0) + bJudge;
    return bScore - aScore;
  });
}

/**
 * Deduplicate signal pool, then return up to 10 AI-ranked signals.
 * Falls back to confidence-based sorting if Claude is unavailable.
 * Results are cached for 15 minutes.
 */
export async function getTopSignals(rawSignals: Signal[]): Promise<RankedSignal[]> {
  if (rawSignals.length === 0) return [];

  const deduped = deduplicateSignals(rawSignals);
  if (deduped.length === 0) return [];

  const now = Date.now();

  // Return cached ranking if still valid and signal count unchanged
  if (cache && cache.expiresAt > now && cache.signalCount === deduped.length) {
    const idOrder = cache.rankedIds;
    const byId = new Map(deduped.map(s => [s.id, s]));
    const ranked = idOrder.map(id => byId.get(id)).filter((s): s is RankedSignal => s !== undefined);
    const missing = deduped.filter(s => !idOrder.includes(s.id));
    return [...ranked, ...missing].slice(0, 10);
  }

  // Use at most 20 signals as input to Claude
  const candidates = deduped.slice(0, 20);
  const prompt = buildRankPrompt(candidates);

  const raw = await callClaude(prompt);

  if (raw) {
    try {
      const cleaned = raw.replace(/```[a-z]*\n?/gi, '').trim();
      const ids: string[] = JSON.parse(cleaned);
      if (Array.isArray(ids) && ids.length > 0) {
        cache = { rankedIds: ids, expiresAt: now + CACHE_TTL_MS, signalCount: deduped.length };
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

  const result = await callClaude(prompt, 45000);
  return result || `${dir} signal on ${signal.matched_asset_name}. Market odds shifted ${deltaSign}${signal.delta_pct.toFixed(1)}% — monitor for follow-through. Rating: MODERATE.`;
}
