import { execFile } from 'child_process';
import { promisify } from 'util';
import { ClaudeVerificationResult, GuardDecision, VerificationContext } from './types.js';

const execFileAsync = promisify(execFile);

const CLAUDE_CANDIDATES = [
  'claude',
  'claude.cmd',
  'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude',
  'C:\\Users\\Adam\\AppData\\Roaming\\npm\\claude.cmd',
  '/usr/local/bin/claude',
  '/usr/bin/claude'
];

function clampAdjustment(value: number): number {
  return Math.max(-20, Math.min(20, Math.round(value)));
}

function sanitizeClaudeJson(raw: string): string {
  return raw.replace(/```json/gi, '').replace(/```/g, '').trim();
}

function parseResult(raw: string): ClaudeVerificationResult | null {
  try {
    const parsed = JSON.parse(sanitizeClaudeJson(raw)) as ClaudeVerificationResult;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!['approve', 'reject', 'needs_review'].includes(parsed.verdict)) return null;
    if (typeof parsed.reason !== 'string') return null;

    return {
      verdict: parsed.verdict,
      confidence_adjustment: clampAdjustment(Number(parsed.confidence_adjustment || 0)),
      reason: parsed.reason.trim().slice(0, 280),
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(flag => String(flag)).slice(0, 8) : [],
      suggested_action_override: parsed.suggested_action_override
        ? String(parsed.suggested_action_override).slice(0, 120)
        : undefined
    };
  } catch {
    return null;
  }
}

function buildPrompt(context: VerificationContext, guard: GuardDecision): string {
  const payload = {
    task: 'Verify if the event has a plausible causal link to the asset direction. Reject weak/entity-noise links.',
    policy: [
      'If unknown person/entity and no direct link to asset, reject.',
      'If link is only generic market mood with no mechanism, needs_review.',
      'Prefer concrete causal channels: rates, policy, supply shocks, sector demand, regulation.',
      'Return JSON only.'
    ],
    signal: {
      market_title: context.marketTitle,
      odds_before: context.oddsBefore,
      odds_now: context.oddsNow,
      delta_pct: context.deltaPct,
      timeframe_minutes: context.timeframeMinutes,
      whale_summary: context.whaleDetected ? `yes (${context.whaleAmountUsd ?? 0} USD)` : 'none',
      matched_asset_id: context.matchedAssetId,
      matched_asset_name: context.matchedAssetName,
      polarity: context.polarity,
      suggested_action: context.suggestedAction,
      ontology_keywords_triggered: context.ontologyKeywords
    },
    context: {
      reinforcing_signals_48h: context.reinforcingSignals.slice(0, 6),
      conflicting_signals_48h: context.conflictingSignals.slice(0, 6),
      deterministic_guard: {
        status: guard.status,
        score: guard.score,
        reason: guard.reason,
        flags: guard.flags,
        known_entity_linked: guard.knownEntityLinked
      }
    },
    response_schema: {
      verdict: 'approve|reject|needs_review',
      confidence_adjustment: '-20..20',
      reason: 'short',
      flags: ['unknown_entity', 'no_link', 'macro_only', 'meme_noise'],
      suggested_action_override: 'optional'
    }
  };

  return `${JSON.stringify(payload, null, 2)}\nRespond with JSON only.`;
}

export class AiTradeVerifier {
  constructor(private timeoutMs = 45000) {}

  async verify(context: VerificationContext, guard: GuardDecision): Promise<ClaudeVerificationResult | null> {
    const prompt = buildPrompt(context, guard);

    for (const binary of CLAUDE_CANDIDATES) {
      try {
        const { stdout } = await execFileAsync(binary, ['-p', prompt], {
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024
        });
        const parsed = parseResult(stdout.trim());
        if (parsed) return parsed;
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }
}
