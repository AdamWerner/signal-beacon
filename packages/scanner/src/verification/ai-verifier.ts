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

function parseResultObject(parsed: unknown): ClaudeVerificationResult | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!['approve', 'reject', 'needs_review'].includes(String(obj.verdict || ''))) return null;
  if (typeof obj.reason !== 'string') return null;

  return {
    verdict: obj.verdict as ClaudeVerificationResult['verdict'],
    confidence_adjustment: clampAdjustment(Number(obj.confidence_adjustment || 0)),
    reason: obj.reason.trim().slice(0, 280),
    flags: Array.isArray(obj.flags) ? obj.flags.map(flag => String(flag)).slice(0, 8) : [],
    suggested_action_override: obj.suggested_action_override
      ? String(obj.suggested_action_override).slice(0, 120)
      : undefined
  };
}

function parseResult(raw: string): ClaudeVerificationResult | null {
  try {
    const parsed = JSON.parse(sanitizeClaudeJson(raw));
    return parseResultObject(parsed);
  } catch {
    return null;
  }
}

function parseBatchResult(raw: string, expectedCount: number): Array<ClaudeVerificationResult | null> | null {
  try {
    const parsed = JSON.parse(sanitizeClaudeJson(raw));
    if (!Array.isArray(parsed)) return null;

    const results: Array<ClaudeVerificationResult | null> = Array.from(
      { length: expectedCount },
      () => null
    );

    parsed.forEach((item, arrayIndex) => {
      if (!item || typeof item !== 'object') return;
      const obj = item as Record<string, unknown>;
      const parsedItem = parseResultObject(obj);
      if (!parsedItem) return;

      const index = Number(obj.index);
      if (Number.isInteger(index) && index >= 0 && index < expectedCount) {
        results[index] = parsedItem;
        return;
      }

      if (arrayIndex < expectedCount) {
        results[arrayIndex] = parsedItem;
      }
    });

    return results;
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

function buildBatchPrompt(contexts: VerificationContext[], guards: GuardDecision[]): string {
  const signals = contexts.map((context, index) => ({
    index,
    market_title: context.marketTitle,
    matched_asset_id: context.matchedAssetId,
    matched_asset_name: context.matchedAssetName,
    polarity: context.polarity,
    suggested_action: context.suggestedAction,
    odds_before: context.oddsBefore,
    odds_now: context.oddsNow,
    delta_pct: context.deltaPct,
    timeframe_minutes: context.timeframeMinutes,
    whale_summary: context.whaleDetected ? `yes (${context.whaleAmountUsd ?? 0} USD)` : 'none',
    ontology_keywords_triggered: context.ontologyKeywords,
    reinforcing_signals_48h: context.reinforcingSignals.slice(0, 4),
    conflicting_signals_48h: context.conflictingSignals.slice(0, 4),
    deterministic_guard: {
      status: guards[index]?.status || 'needs_review',
      score: guards[index]?.score || 0,
      reason: guards[index]?.reason || 'missing_guard',
      flags: guards[index]?.flags || [],
      known_entity_linked: guards[index]?.knownEntityLinked || false
    }
  }));

  const payload = {
    task: `Here are ${signals.length} trading signals. For each, return a verdict.`,
    policy: [
      'Reject unknown-entity noise and weak causal links.',
      'Use needs_review when linkage is plausible but not specific enough.',
      'Only approve when there is a clear and plausible causal channel.',
      'Respond with a JSON array only.'
    ],
    signals,
    response_schema: {
      index: '0-based index from the input item',
      verdict: 'approve|reject|needs_review',
      confidence_adjustment: '-20..20',
      reason: 'short',
      flags: ['unknown_entity', 'no_link', 'macro_only', 'meme_noise'],
      suggested_action_override: 'optional'
    }
  };

  return `${JSON.stringify(payload, null, 2)}\nRespond with JSON array only.`;
}

export class AiTradeVerifier {
  constructor(
    private timeoutMs = 45000,
    private batchTimeoutMs = 60000
  ) {}

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

  async batchVerify(
    contexts: VerificationContext[],
    guards: GuardDecision[]
  ): Promise<Array<ClaudeVerificationResult | null> | null> {
    if (contexts.length === 0) return [];

    const prompt = buildBatchPrompt(contexts, guards);

    for (const binary of CLAUDE_CANDIDATES) {
      try {
        const { stdout } = await execFileAsync(binary, ['-p', prompt], {
          timeout: this.batchTimeoutMs,
          maxBuffer: 2 * 1024 * 1024
        });
        const parsed = parseBatchResult(stdout.trim(), contexts.length);
        if (parsed) return parsed;
      } catch {
        // Try next candidate.
      }
    }

    return null;
  }
}
