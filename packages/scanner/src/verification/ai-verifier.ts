import { ClaudeVerificationResult, GuardDecision, VerificationContext } from './types.js';
import { getLocalAiProviderLabel, runLocalAiPrompt } from '../utils/local-ai-cli.js';

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

function buildBatchPrompt(contexts: VerificationContext[], guards: GuardDecision[], newsContext?: string): string {
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

  const payload: Record<string, unknown> = {
    task: `Here are ${signals.length} trading signals from Polymarket. For each, return a verdict. Rank them from most to least actionable.`,
    policy: [
      'Reject unknown-entity noise and weak causal links.',
      'Use needs_review when linkage is plausible but not specific enough.',
      'Only approve when there is a clear and plausible causal channel.',
      'Cross-reference each signal against the recent news headlines below.',
      'If news confirms the signal direction, increase confidence_adjustment by +5 to +10.',
      'If news contradicts, decrease by -5 to -15 or reject.',
      'Ask: would a professional trader act on this within 2-4 minutes? Only approve if yes.',
      'Respond with a JSON array only, ordered from most actionable to least.'
    ],
    signals,
    response_schema: {
      index: '0-based index from the input item (preserve original index)',
      verdict: 'approve|reject|needs_review',
      confidence_adjustment: '-20..20',
      reason: 'short - include news cross-reference if relevant',
      flags: ['unknown_entity', 'no_link', 'macro_only', 'meme_noise', 'news_confirms', 'news_contradicts'],
      suggested_action_override: 'optional'
    }
  };

  if (newsContext) {
    payload.recent_news_headlines_6h = newsContext;
  }

  return `${JSON.stringify(payload, null, 2)}\nRespond with JSON array only.`;
}

export class AiTradeVerifier {
  private enabled = (process.env.CLAUDE_VERIFY_ENABLED || 'true').toLowerCase() !== 'false';
  private consecutiveFailures = 0;
  private backoffUntilMs = 0;
  private lastBackoffLogAt = 0;
  private disableAfterFailures = Math.max(1, parseInt(process.env.CLAUDE_VERIFY_DISABLE_AFTER_FAILS || '5', 10));

  constructor(
    private timeoutMs = 45000,
    private batchTimeoutMs = 60000
  ) {}

  private isInBackoff(scope: 'single' | 'batch'): boolean {
    if (Date.now() >= this.backoffUntilMs) return false;
    if (Date.now() - this.lastBackoffLogAt > 60_000) {
      const seconds = Math.max(1, Math.round((this.backoffUntilMs - Date.now()) / 1000));
      console.warn(`[verify] ${getLocalAiProviderLabel()} ${scope} skipped during cooldown (${seconds}s remaining)`);
      this.lastBackoffLogAt = Date.now();
    }
    return true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.backoffUntilMs = 0;
  }

  private recordFailure(scope: 'single' | 'batch', errors: string[]): void {
    this.consecutiveFailures += 1;
    const backoffMs = Math.min(10 * 60_000, this.consecutiveFailures * 60_000);
    this.backoffUntilMs = Date.now() + backoffMs;
    this.lastBackoffLogAt = Date.now();
    const detail = errors.slice(-3).join(' | ');
    console.warn(
      `[verify] ${getLocalAiProviderLabel()} ${scope} failed (${this.consecutiveFailures}x); ` +
      `cooldown ${Math.round(backoffMs / 1000)}s. ${detail}`
    );

    if (this.consecutiveFailures >= this.disableAfterFailures) {
      this.enabled = false;
      console.warn(
        `[verify] ${getLocalAiProviderLabel()} verifier disabled after ${this.consecutiveFailures} consecutive failures. ` +
        'Set CLAUDE_VERIFY_ENABLED=true and restart to re-enable.'
      );
    }
  }

  async verify(context: VerificationContext, guard: GuardDecision): Promise<ClaudeVerificationResult | null> {
    if (!this.enabled) return null;
    if (this.isInBackoff('single')) return null;

    const prompt = buildPrompt(context, guard);
    const result = await runLocalAiPrompt(prompt, {
      timeoutMs: this.timeoutMs,
      maxBufferBytes: 1024 * 1024,
      usageContext: 'verify-single',
      logContext: 'verify-single'
    });
    const errors = [...result.errors];
    if (result.ok) {
      const parsed = parseResult(result.stdout);
      if (parsed) {
        this.recordSuccess();
        return parsed;
      }
      errors.push(`${result.binary || 'local-ai'}: invalid JSON response`);
    }

    this.recordFailure('single', errors);
    return null;
  }

  async batchVerify(
    contexts: VerificationContext[],
    guards: GuardDecision[],
    newsContext?: string
  ): Promise<Array<ClaudeVerificationResult | null> | null> {
    if (contexts.length === 0) return [];
    if (!this.enabled) return null;
    if (this.isInBackoff('batch')) return null;

    const prompt = buildBatchPrompt(contexts, guards, newsContext);
    const result = await runLocalAiPrompt(prompt, {
      timeoutMs: this.batchTimeoutMs,
      maxBufferBytes: 2 * 1024 * 1024,
      usageContext: 'batch-verify',
      logContext: 'batch-verify'
    });
    const errors = [...result.errors];
    if (result.ok) {
      const parsed = parseBatchResult(result.stdout, contexts.length);
      if (parsed) {
        this.recordSuccess();
        return parsed;
      }
      errors.push(`${result.binary || 'local-ai'}: invalid JSON response`);
    }

    this.recordFailure('batch', errors);
    return null;
  }
}
