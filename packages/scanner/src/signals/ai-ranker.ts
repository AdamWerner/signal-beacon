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

async function rankWithClaude(prompt: string): Promise<string> {
  for (const bin of CLAUDE_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(bin, ['-p', prompt], {
        timeout: 60000,
        maxBuffer: 1024 * 1024
      });
      return stdout.trim();
    } catch {
      // Try next candidate
    }
  }
  console.error('Claude CLI not found in any known location — using fallback ranking');
  return '';
}

function buildPrompt(signals: Signal[]): string {
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

function fallbackRank(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    // Penalise context_dependent signals
    const aJudge = a.requires_judgment ? -10 : 0;
    const bJudge = b.requires_judgment ? -10 : 0;
    const aScore = a.confidence + Math.min(Math.abs(a.delta_pct), 30) + (a.whale_detected ? 10 : 0) + aJudge;
    const bScore = b.confidence + Math.min(Math.abs(b.delta_pct), 30) + (b.whale_detected ? 10 : 0) + bJudge;
    return bScore - aScore;
  });
}

/**
 * Return up to 10 top-ranked signals using Claude CLI (cached 15 min).
 * Falls back to confidence-based sorting if claude is unavailable.
 */
export async function getTopSignals(signals: Signal[]): Promise<Signal[]> {
  if (signals.length === 0) return [];

  const now = Date.now();

  // Return cached ranking if still valid and signal count unchanged
  if (cache && cache.expiresAt > now && cache.signalCount === signals.length) {
    const idOrder = cache.rankedIds;
    const byId = new Map(signals.map(s => [s.id, s]));
    const ranked = idOrder.map(id => byId.get(id)).filter((s): s is Signal => s !== undefined);
    // Append any signals not in the cached ranking (shouldn't happen but safety net)
    const missing = signals.filter(s => !idOrder.includes(s.id));
    return [...ranked, ...missing].slice(0, 10);
  }

  // Use at most 20 signals as input to Claude
  const candidates = signals.slice(0, 20);
  const prompt = buildPrompt(candidates);

  const raw = await rankWithClaude(prompt);

  if (raw) {
    try {
      // Strip any accidental markdown fences just in case
      const cleaned = raw.replace(/```[a-z]*\n?/gi, '').trim();
      const ids: string[] = JSON.parse(cleaned);
      if (Array.isArray(ids) && ids.length > 0) {
        cache = { rankedIds: ids, expiresAt: now + CACHE_TTL_MS, signalCount: signals.length };
        const byId = new Map(candidates.map(s => [s.id, s]));
        return ids.map(id => byId.get(id)).filter((s): s is Signal => s !== undefined).slice(0, 10);
      }
    } catch {
      console.error('Failed to parse Claude ranking response:', raw.substring(0, 200));
    }
  }

  // Fallback: confidence-based sort
  console.log('Using fallback confidence-based signal ranking');
  return fallbackRank(candidates).slice(0, 10);
}
