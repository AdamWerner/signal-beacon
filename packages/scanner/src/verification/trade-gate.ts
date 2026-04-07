import { AiTradeVerifier } from './ai-verifier.js';
import { EntityRelevanceGuard } from './entity-guard.js';
import { GuardDecision, VerificationContext, VerificationDecision } from './types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mergeFlags(...flagSets: string[][]): string[] {
  return [...new Set(flagSets.flat().filter(Boolean))];
}

export interface BatchVerificationCandidate {
  signalId: string;
  confidence: number;
  context: VerificationContext;
  guard: GuardDecision;
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

  guardOnly(context: VerificationContext): VerificationDecision {
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

    if (guard.status === 'needs_review') {
      return {
        status: 'needs_review',
        score: guard.score,
        reason: guard.reason,
        flags: mergeFlags(guard.flags),
        source: 'guard',
        confidenceAdjustment: -5,
        record: { guard }
      };
    }

    return {
      status: 'approved',
      score: guard.score,
      reason: guard.reason,
      flags: mergeFlags(guard.flags),
      source: 'guard',
      confidenceAdjustment: 0,
      record: { guard }
    };
  }

  private mergeGuardWithAi(guard: GuardDecision, aiVerdict: Awaited<ReturnType<AiTradeVerifier['verify']>>): VerificationDecision {
    if (!aiVerdict) {
      return this.guardOnlyFromDecision(guard);
    }

    const status =
      aiVerdict.verdict === 'approve'
        ? 'approved'
        : aiVerdict.verdict === 'reject'
          ? 'rejected'
          : 'needs_review';

    const score = clamp(guard.score + aiVerdict.confidence_adjustment, 0, 100);
    return {
      status,
      score,
      reason: aiVerdict.reason || guard.reason,
      flags: mergeFlags(guard.flags, aiVerdict.flags),
      source: 'claude',
      confidenceAdjustment: aiVerdict.confidence_adjustment,
      suggestedActionOverride: aiVerdict.suggested_action_override,
      record: {
        guard,
        claude: aiVerdict
      }
    };
  }

  private guardOnlyFromDecision(guard: GuardDecision): VerificationDecision {
    if (guard.status === 'approved' && guard.allowlistedMarketType) {
      return {
        status: 'approved',
        score: guard.score,
        reason: `${guard.reason}. AI unavailable; guard-only fallback applied.`,
        flags: mergeFlags(guard.flags, ['ai_unavailable']),
        source: 'guard_allowlist',
        confidenceAdjustment: 0,
        record: { guard, fallbackReason: 'claude_unavailable_guard_fallback' }
      };
    }

    // When AI is unavailable and the signal has a high guard score but was flagged only
    // for negated market language (not unknown entity or other serious issues), auto-approve.
    // Score of 60+ means strong keyword+entity match — the negation is in the description,
    // not the causal relationship between market and asset.
    if (
      guard.status === 'needs_review' &&
      guard.score >= 60 &&
      guard.flags.length > 0 &&
      guard.flags.every(f => f === 'negated_market_language')
    ) {
      return {
        status: 'approved',
        score: guard.score,
        reason: `${guard.reason}. AI unavailable; high-score negated-language approved by guard fallback.`,
        flags: mergeFlags(guard.flags, ['ai_unavailable', 'guard_fallback_approved']),
        source: 'fallback_guard',
        confidenceAdjustment: -5,
        record: { guard, fallbackReason: 'negated_language_high_score_fallback' }
      };
    }

    const base = this.guardOnlyFromStrictGuard(guard);
    return {
      ...base,
      flags: mergeFlags(base.flags, ['ai_unavailable']),
      record: { ...base.record, fallbackReason: 'claude_unavailable_guard_fallback' }
    };
  }

  private guardOnlyFromStrictGuard(guard: GuardDecision): VerificationDecision {
    if (guard.status === 'rejected') {
      return {
        status: 'rejected',
        score: guard.score,
        reason: guard.reason,
        flags: mergeFlags(guard.flags),
        source: 'fallback_guard',
        confidenceAdjustment: 0,
        record: { guard }
      };
    }

    if (guard.status === 'needs_review') {
      return {
        status: 'needs_review',
        score: guard.score,
        reason: guard.reason,
        flags: mergeFlags(guard.flags),
        source: 'fallback_guard',
        confidenceAdjustment: 0,
        record: { guard }
      };
    }

    return {
      status: 'approved',
      score: guard.score,
      reason: guard.reason,
      flags: mergeFlags(guard.flags),
      source: 'fallback_guard',
      confidenceAdjustment: 0,
      record: { guard }
    };
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
      return this.guardOnlyFromDecision(guard);
    }

    return this.mergeGuardWithAi(guard, ai);
  }

  async batchVerifyTopCandidates(
    candidates: BatchVerificationCandidate[],
    maxCount = 5,
    newsContext?: string
  ): Promise<Map<string, VerificationDecision>> {
    const result = new Map<string, VerificationDecision>();
    const shortlist = candidates
      .filter(candidate => ['approved', 'needs_review'].includes(candidate.guard.status))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxCount);

    if (shortlist.length === 0) {
      return result;
    }

    // Skip Claude when fewer than 2 signals fully passed the entity guard —
    // not worth a CLI call for borderline/rejected candidates.
    const guardApprovedCount = shortlist.filter(c => c.guard.status === 'approved').length;
    if (guardApprovedCount < 2) {
      console.log(
        `[verify] Skipping Claude batch — only ${guardApprovedCount} guard-approved candidates (need 2+); using guard-only fallback`
      );
      for (const item of shortlist) {
        result.set(item.signalId, this.guardOnlyFromDecision(item.guard));
      }
      return result;
    }

    const contexts = shortlist.map(item => item.context);
    const guards = shortlist.map(item => item.guard);
    const batch = await this.aiVerifier.batchVerify(contexts, guards, newsContext);

    if (!batch) {
      console.warn(
        `[verify] Claude batch verification unavailable; using guard-only fallback for ${shortlist.length} candidates`
      );
      for (const item of shortlist) {
        result.set(item.signalId, this.guardOnlyFromDecision(item.guard));
      }
      return result;
    }

    shortlist.forEach((item, index) => {
      const aiVerdict = batch[index];
      if (!aiVerdict) {
        result.set(item.signalId, this.guardOnlyFromDecision(item.guard));
        return;
      }
      result.set(item.signalId, this.mergeGuardWithAi(item.guard, aiVerdict));
    });

    return result;
  }
}
