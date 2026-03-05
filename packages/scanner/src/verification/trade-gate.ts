import { AiTradeVerifier } from './ai-verifier.js';
import { EntityRelevanceGuard } from './entity-guard.js';
import { VerificationContext, VerificationDecision } from './types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mergeFlags(...flagSets: string[][]): string[] {
  return [...new Set(flagSets.flat().filter(Boolean))];
}

export class TradeVerificationGate {
  private guard: EntityRelevanceGuard;
  private aiVerifier: AiTradeVerifier;

  constructor(params: {
    entityConfidenceThreshold: number;
    unknownPersonLegalEventPolicy: 'block' | 'review';
    aiTimeoutMs?: number;
  }) {
    this.guard = new EntityRelevanceGuard(
      params.entityConfidenceThreshold,
      params.unknownPersonLegalEventPolicy
    );
    this.aiVerifier = new AiTradeVerifier(params.aiTimeoutMs);
  }

  async verify(context: VerificationContext): Promise<VerificationDecision> {
    const guard = this.guard.evaluate(context);

    if (guard.status === 'rejected') {
      return {
        status: 'rejected',
        score: guard.score,
        reason: guard.reason,
        flags: mergeFlags(guard.flags),
        source: 'guard',
        confidenceAdjustment: -15,
        record: { guard }
      };
    }

    const ai = await this.aiVerifier.verify(context, guard);
    if (!ai) {
      if (guard.status === 'approved' && guard.allowlistedMarketType) {
        return {
          status: 'approved',
          score: guard.score,
          reason: `${guard.reason}. AI unavailable; allowlisted market type fallback applied.`,
          flags: mergeFlags(guard.flags, ['ai_unavailable']),
          source: 'guard_allowlist',
          confidenceAdjustment: 0,
          record: { guard, fallbackReason: 'claude_unavailable_allowlist_fallback' }
        };
      }

      return {
        status: 'needs_review',
        score: guard.score,
        reason: `${guard.reason}. AI verifier unavailable.`,
        flags: mergeFlags(guard.flags, ['ai_unavailable']),
        source: 'fallback_guard',
        confidenceAdjustment: -5,
        record: { guard, fallbackReason: 'claude_unavailable' }
      };
    }

    const status =
      ai.verdict === 'approve'
        ? 'approved'
        : ai.verdict === 'reject'
          ? 'rejected'
          : 'needs_review';

    const score = clamp(guard.score + ai.confidence_adjustment, 0, 100);
    return {
      status,
      score,
      reason: ai.reason || guard.reason,
      flags: mergeFlags(guard.flags, ai.flags),
      source: 'claude',
      confidenceAdjustment: ai.confidence_adjustment,
      suggestedActionOverride: ai.suggested_action_override,
      record: {
        guard,
        claude: ai
      }
    };
  }
}
