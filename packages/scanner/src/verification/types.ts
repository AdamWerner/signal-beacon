export type VerificationStatus = 'pending' | 'approved' | 'rejected' | 'needs_review';

export interface GuardDecision {
  status: VerificationStatus;
  score: number;
  reason: string;
  flags: string[];
  matchedKeywords: string[];
  extractedPersons: string[];
  extractedEntities: string[];
  knownEntityLinked: boolean;
  allowlistedMarketType: boolean;
}

export interface ClaudeVerificationResult {
  verdict: 'approve' | 'reject' | 'needs_review';
  confidence_adjustment: number;
  reason: string;
  flags: string[];
  suggested_action_override?: string;
}

export interface VerificationDecision {
  status: VerificationStatus;
  score: number;
  reason: string;
  flags: string[];
  source: 'guard' | 'claude' | 'fallback_guard' | 'guard_allowlist';
  confidenceAdjustment: number;
  suggestedActionOverride?: string;
  record: {
    guard: GuardDecision;
    claude?: ClaudeVerificationResult;
    fallbackReason?: string;
  };
}

export interface VerificationContext {
  marketTitle: string;
  marketDescription: string | null;
  marketCategory: string | null;
  matchedAssetId: string;
  matchedAssetName: string;
  polarity: 'direct' | 'inverse' | 'context_dependent';
  suggestedAction: string;
  oddsBefore: number;
  oddsNow: number;
  deltaPct: number;
  timeframeMinutes: number;
  whaleDetected: boolean;
  whaleAmountUsd: number | null;
  ontologyKeywords: string[];
  reinforcingSignals: Array<{ id: string; asset: string; confidence: number; direction: string }>;
  conflictingSignals: Array<{ id: string; asset: string; confidence: number; direction: string }>;
}
