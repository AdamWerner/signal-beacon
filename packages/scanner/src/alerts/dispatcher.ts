import { PushoverClient } from './pushover.js';
import { WebhookClient } from './webhook.js';
import { HomeAssistantAlert } from './homeassistant.js';
import { AlertConfig } from './types.js';
import { GeneratedSignal } from '../signals/types.js';
import { getAssetMarket, isMarketOpen } from '../intelligence/trading-hours.js';
import { estimateExecutionCost } from '../intelligence/execution-feasibility.js';
import { runLocalAiPrompt } from '../utils/local-ai-cli.js';
import { shouldDoDeepVerify } from '../utils/ai-budget.js';

export class AlertDispatcher {
  private pushover?: PushoverClient;
  private webhook?: WebhookClient;
  private homeAssistant?: HomeAssistantAlert;
  private signalStore?: AlertConfig['signalStore'];
  private haMinConfidence: number;
  private minConfidence: number;
  private verificationRequiredForPush: boolean;
  private onSignalsPushed?: (signalIds: string[], market: 'swedish' | 'us') => void;
  private sameDirectionCooldownMinutes: number;
  private reversalCooldownMinutes: number;
  private reversalMinDeltaPct: number;
  private reversalMinOddsSwingPp: number;
  private reversalMinConfidenceGain: number;
  private reversalReinforcementMinutes: number;
  private reversalMinDistinctMarkets: number;
  private readonly highRiskVerificationFlags = new Set([
    'unknown_entity',
    'no_link',
    'low_entity_confidence',
    'unknown_person_legal_event'
  ]);

  constructor(config: AlertConfig) {
    this.minConfidence = config.minConfidence || 50;
    this.haMinConfidence = config.homeAssistant?.minConfidence ?? 65;
    this.verificationRequiredForPush = config.verificationRequiredForPush ?? true;
    this.onSignalsPushed = config.onSignalsPushed;
    this.signalStore = config.signalStore;
    this.sameDirectionCooldownMinutes = Math.max(0, parseInt(process.env.PUSH_SAME_DIRECTION_COOLDOWN_MINUTES || '20', 10));
    this.reversalCooldownMinutes = Math.max(0, parseInt(process.env.PUSH_REVERSAL_COOLDOWN_MINUTES || '45', 10));
    this.reversalMinDeltaPct = Math.max(0, parseFloat(process.env.PUSH_REVERSAL_MIN_DELTA_PCT || '35'));
    this.reversalMinOddsSwingPp = Math.max(0, parseFloat(process.env.PUSH_REVERSAL_MIN_ODDS_SWING_PP || '0.20'));
    this.reversalMinConfidenceGain = Math.max(0, parseFloat(process.env.PUSH_REVERSAL_MIN_CONFIDENCE_GAIN || '8'));
    this.reversalReinforcementMinutes = Math.max(1, parseInt(process.env.PUSH_REVERSAL_REINFORCEMENT_MINUTES || '45', 10));
    this.reversalMinDistinctMarkets = Math.max(1, parseInt(process.env.PUSH_REVERSAL_MIN_DISTINCT_MARKETS || '2', 10));

    if (config.pushover) {
      this.pushover = new PushoverClient(config.pushover);
    }

    if (config.webhook) {
      this.webhook = new WebhookClient(config.webhook);
    }

    if (config.homeAssistant?.enabled && config.homeAssistant.url && config.homeAssistant.token) {
      this.homeAssistant = new HomeAssistantAlert(
        config.homeAssistant.url,
        config.homeAssistant.token,
        config.homeAssistant.notifyService
      );
    }
  }

  /**
   * Dispatch alerts for multiple signals, aggregated per market and cycle.
   * Returns actual counts of pushed and brewed signals.
   */
  async dispatchBatch(signals: GeneratedSignal[]): Promise<{ pushedSwedish: number; pushedUs: number; brewed: number }> {
    const diagnostics = {
      totalSignals: signals.length,
      skippedMinConfidence: 0,
      skippedRequiresJudgment: 0,
      skippedVerification: 0,
      skippedThresholds: 0,
      skippedExecution: 0,
      skippedQuality: 0,
      skippedReplay: 0,
      skippedWhipsaw: 0,
      skippedPolicy: 0,
      skippedEvidence: 0,
      skippedDeepVerify: 0,
      pushed: 0,
      brewedClosed: 0
    };

    for (const signal of signals) {
      await this.dispatchLegacy(signal);
    }

    if (!this.homeAssistant) {
      return { pushedSwedish: 0, pushedUs: 0, brewed: 0 };
    }

    const swedish: GeneratedSignal[] = [];
    const us: GeneratedSignal[] = [];

    for (const signal of signals) {
      if (signal.confidence < this.minConfidence) {
        diagnostics.skippedMinConfidence += 1;
        continue;
      }
      if (signal.requires_judgment) {
        diagnostics.skippedRequiresJudgment += 1;
        continue;
      }
      if (this.verificationRequiredForPush && !this.isEligibleByVerification(signal)) {
        diagnostics.skippedVerification += 1;
        console.log(
          `  Skip push ${signal.id} not verification-approved ` +
          `(${signal.verification_status}/${signal.verification_source})`
        );
        continue;
      }

      const market = getAssetMarket(signal.matched_asset_id);
      if (market === 'swedish') {
        swedish.push(signal);
      } else {
        us.push(signal);
      }
    }

    const pushedSwedish = await this.dispatchAggregated(swedish, 'swedish', diagnostics);
    const pushedUs = await this.dispatchAggregated(us, 'us', diagnostics);
    const brewed = diagnostics.brewedClosed;
    diagnostics.pushed = pushedSwedish + pushedUs;

    console.log(
      `  Push audit: total=${diagnostics.totalSignals} pushed=${diagnostics.pushed} brewed_closed=${brewed} ` +
      `skip[min=${diagnostics.skippedMinConfidence}, judgment=${diagnostics.skippedRequiresJudgment}, ` +
      `verify=${diagnostics.skippedVerification}, thresholds=${diagnostics.skippedThresholds}, ` +
      `execution=${diagnostics.skippedExecution}, quality=${diagnostics.skippedQuality}, replay=${diagnostics.skippedReplay}, ` +
      `whipsaw=${diagnostics.skippedWhipsaw}, policy=${diagnostics.skippedPolicy}, ` +
      `evidence=${diagnostics.skippedEvidence}, deep=${diagnostics.skippedDeepVerify}]`
    );

    return { pushedSwedish, pushedUs, brewed };
  }

  /**
   * Send one aggregated notification for all pushable signals in a market.
   * Returns count of assets actually pushed.
   */
  private async dispatchAggregated(
    signals: GeneratedSignal[],
    market: 'swedish' | 'us',
    diagnostics: {
      skippedThresholds: number;
      skippedExecution: number;
      skippedQuality: number;
      skippedReplay: number;
      skippedWhipsaw: number;
      skippedPolicy: number;
      skippedEvidence: number;
      skippedDeepVerify: number;
      brewedClosed: number;
    }
  ): Promise<number> {
    const homeAssistant = this.homeAssistant;
    if (!homeAssistant) return 0;
    if (signals.length === 0) return 0;

    if (!isMarketOpen(market)) {
      for (const signal of signals) {
        console.log(`  Brewing signal ${signal.id} (${signal.matched_asset_name} ${signal.confidence}%) - ${market} market closed`);
      }
      diagnostics.brewedClosed += signals.length;
      return 0;
    }

    const policy = this.signalStore?.getPushPolicyConfig(market);
    const maxPolicyMinConfidence = Math.max(
      this.haMinConfidence,
      parseInt(process.env.PUSH_POLICY_MAX_MIN_CONFIDENCE || '72', 10)
    );
    const maxPolicyMinDeltaPct = Math.max(
      15,
      parseFloat(process.env.PUSH_POLICY_MAX_MIN_DELTA_PCT || '25')
    );
    const maxPolicyMinEvidenceScore = Math.max(
      2,
      parseInt(process.env.PUSH_POLICY_MAX_MIN_EVIDENCE_SCORE || '3', 10)
    );

    const rawPolicyMinConfidence = policy?.minConfidence ?? this.haMinConfidence;
    const rawPolicyMinDeltaPct = policy?.minDeltaPct ?? 15;
    const rawPolicyMinEvidenceScore = policy?.minEvidenceScore ?? 3;
    const policyMinConfidence = Math.min(rawPolicyMinConfidence, maxPolicyMinConfidence);
    const policyMinDeltaPct = Math.min(rawPolicyMinDeltaPct, maxPolicyMinDeltaPct);
    const policyMinEvidenceScore = Math.min(rawPolicyMinEvidenceScore, maxPolicyMinEvidenceScore);

    if (
      rawPolicyMinConfidence !== policyMinConfidence ||
      rawPolicyMinDeltaPct !== policyMinDeltaPct ||
      rawPolicyMinEvidenceScore !== policyMinEvidenceScore
    ) {
      console.log(
        `  [policy] clamped ${market} thresholds ` +
        `conf ${rawPolicyMinConfidence}->${policyMinConfidence}, ` +
        `delta ${rawPolicyMinDeltaPct}->${policyMinDeltaPct}, ` +
        `evidence ${rawPolicyMinEvidenceScore}->${policyMinEvidenceScore}`
      );
    }

    const pushable = signals.filter(signal =>
      signal.confidence >= policyMinConfidence &&
      Math.abs(signal.delta_pct) >= policyMinDeltaPct &&
      signal.verification_status === 'approved'
    );

    const catalystPushable = signals.filter(signal =>
      this.isCatalystConvergenceSignal(signal) &&
      signal.confidence >= Math.max(55, policyMinConfidence - 15) &&
      Math.abs(signal.delta_pct) >= Math.max(12, policyMinDeltaPct - 5) &&
      signal.verification_status === 'approved'
    );

    const allPushable = [...pushable];
    for (const catalystSignal of catalystPushable) {
      if (!allPushable.find(signal => signal.id === catalystSignal.id)) {
        allPushable.push(catalystSignal);
      }
    }

    if (allPushable.length === 0) {
      for (const signal of signals) {
        diagnostics.skippedThresholds += 1;
        console.log(
          `  Skip push ${signal.id} below thresholds (` +
          `conf=${signal.confidence}%/${policyMinConfidence} ` +
          `delta=${Math.abs(signal.delta_pct).toFixed(1)}%/${policyMinDeltaPct})`
        );
      }
      return 0;
    }

    const byAsset = new Map<string, GeneratedSignal>();
    for (const signal of allPushable) {
      const existing = byAsset.get(signal.matched_asset_id);
      if (!existing || signal.confidence > existing.confidence) {
        byAsset.set(signal.matched_asset_id, signal);
      }
    }

    const dedupedSignals = Array.from(byAsset.values()).sort((a, b) => b.confidence - a.confidence);
    if (dedupedSignals.length === 0) return 0;

    for (const candidate of dedupedSignals) {
      const leverage = candidate.suggested_instruments[0]?.leverage ?? 3;
      const execution = estimateExecutionCost(candidate.matched_asset_id, leverage || 3);
      candidate.reasoning += ` [execution: ${execution.note}]`;
      if (!execution.feasible) {
        diagnostics.skippedExecution += 1;
        console.log(`  Skip push ${candidate.id} execution gate: ${execution.note}`);
        continue;
      }

      const qualityBlock = this.getPushQualityBlockReason(candidate);
      if (qualityBlock) {
        diagnostics.skippedQuality += 1;
        console.log(`  Skip push ${candidate.id} quality gate: ${qualityBlock}`);
        continue;
      }

      const replayGate = this.evaluateExecutionReplayGate(candidate);
      if (!replayGate.allowed) {
        diagnostics.skippedReplay += 1;
        console.log(`  Skip push ${candidate.id} replay gate: ${replayGate.reason}`);
        continue;
      }

      const regimeGate = this.evaluateRegimeShiftGate(candidate);
      if (!regimeGate.allowed) {
        diagnostics.skippedWhipsaw += 1;
        console.log(`  Skip push ${candidate.id} anti-whipsaw: ${regimeGate.reason}`);
        continue;
      }

      const performanceGate = this.evaluatePushPerformanceGate(candidate);
      if (!performanceGate.allowed) {
        diagnostics.skippedPolicy += 1;
        console.log(`  Skip push ${candidate.id} push-policy: ${performanceGate.reason}`);
        continue;
      }

      const evidenceGate = this.evaluateEvidenceGate(
        candidate,
        policyMinConfidence,
        policyMinEvidenceScore
      );
      if (!evidenceGate.allowed) {
        diagnostics.skippedEvidence += 1;
        console.log(`  Skip push ${candidate.id} evidence gate: ${evidenceGate.reason}`);
        continue;
      }

      // Final deep verification — one Claude call with full context, only fires when about to push
      const deepResult = await this.deepVerify(candidate);
      if (deepResult) {
        if (deepResult.verdict === 'reject') {
          diagnostics.skippedDeepVerify += 1;
          console.log(`  [deep-verify] BLOCKED push ${candidate.id}: ${deepResult.reason}`);
          continue;
        }
        candidate.verification_reason = deepResult.reason;
        if (deepResult.confidence_adjustment) {
          candidate.confidence = Math.max(0, Math.min(
            candidate.confidence + deepResult.confidence_adjustment, 92
          ));
        }
      }

      const DRY_RUN = process.env.DRY_RUN === 'true';
      if (DRY_RUN) {
        const dryTitle = `${candidate.suggested_action} ${candidate.matched_asset_name} ${candidate.confidence}%`;
        const dryMessage = `${candidate.reasoning} | ${candidate.verification_reason}`;
        console.log(`[DRY_RUN] Would push: ${dryTitle} | ${dryMessage}`);
        return 1;
      }

      const sent = await homeAssistant.send(candidate);

      if (!sent) {
        console.warn(`  HA push attempt failed for ${market} market (${candidate.matched_asset_name})`);
        continue;
      }

      if (this.onSignalsPushed) {
        this.onSignalsPushed([candidate.id], market);
      }

      console.log(`  Pushed top ${market} HA alert (${candidate.matched_asset_name} ${candidate.confidence}%)`);
      return 1;
    }

    return 0;
  }

  /**
   * Legacy per-signal dispatch for non-HA channels.
   */
  private async dispatchLegacy(signal: GeneratedSignal): Promise<void> {
    if (signal.confidence < this.minConfidence) return;
    if (this.verificationRequiredForPush && !this.isEligibleByVerification(signal)) return;

    const promises: Promise<boolean>[] = [];
    if (this.pushover) promises.push(this.pushover.send(signal));
    if (this.webhook) promises.push(this.webhook.send(signal));

    await Promise.all(promises);
  }

  private isEligibleByVerification(signal: GeneratedSignal): boolean {
    if (signal.verification_status !== 'approved') return false;
    if (signal.verification_source === 'guard_allowlist') return true;
    if (signal.verification_source === 'claude' || signal.verification_source === 'guard') return true;
    if (signal.verification_source !== 'fallback_guard') return false;
    return this.isTrustedFallbackGuard(signal);
  }

  private isTrustedFallbackGuard(signal: GeneratedSignal): boolean {
    const flags = this.getVerificationFlags(signal);
    if (flags.some(flag => this.highRiskVerificationFlags.has(flag))) return false;
    return Number(signal.verification_score || 0) >= 55;
  }

  private getVerificationFlags(signal: GeneratedSignal): string[] {
    const raw = (signal as any).verification_flags as unknown;
    if (Array.isArray(raw)) {
      return raw.map(flag => String(flag));
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map(flag => String(flag));
        }
      } catch {
        return [raw];
      }
    }
    return [];
  }

  private getSignalDirection(signal: { suggested_action: string }): 'bull' | 'bear' {
    return signal.suggested_action.toLowerCase().includes('bull') ? 'bull' : 'bear';
  }

  private isCatalystConvergenceSignal(signal: Partial<GeneratedSignal>): boolean {
    return String(signal.signal_origin || 'polymarket').trim() === 'catalyst_convergence';
  }

  private parseDbTimestamp(value: string | null | undefined): Date | null {
    if (!value) return null;
    const normalized = value.replace(' ', 'T');
    const parsed = new Date(`${normalized}Z`);
    if (!Number.isFinite(parsed.getTime())) {
      const fallback = new Date(value);
      return Number.isFinite(fallback.getTime()) ? fallback : null;
    }
    return parsed;
  }

  private isMicroTimeboxMarket(title: string): boolean {
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

  private getPushQualityBlockReason(signal: GeneratedSignal): string | null {
    if (this.isMicroTimeboxMarket(signal.market_title)) {
      return 'micro-timebox market (high settlement noise, low causal certainty)';
    }

    const absOddsSwing = Math.abs(signal.odds_now - signal.odds_before);
    if (signal.time_window_minutes <= 15 && absOddsSwing >= 0.85) {
      return 'extreme short-window odds snap (likely market settlement noise)';
    }

    return null;
  }

  private evaluateRegimeShiftGate(signal: GeneratedSignal): { allowed: boolean; reason: string } {
    if (!this.signalStore) {
      return { allowed: true, reason: 'signal store unavailable' };
    }

    const lookbackMinutes = Math.max(this.sameDirectionCooldownMinutes, this.reversalCooldownMinutes) + 120;
    const previous = this.signalStore.getLatestPushedSignalForAsset(signal.matched_asset_id, lookbackMinutes);
    if (!previous) {
      return { allowed: true, reason: 'no previous pushed signal for asset' };
    }

    const previousDirection = this.getSignalDirection(previous);
    const nextDirection = this.getSignalDirection(signal);
    const previousTime = this.parseDbTimestamp(previous.push_sent_at || previous.timestamp);
    if (!previousTime) {
      return { allowed: true, reason: 'previous push timestamp missing' };
    }

    const elapsedMinutes = (Date.now() - previousTime.getTime()) / 60000;
    if (elapsedMinutes < 0) {
      return { allowed: true, reason: 'clock skew ignored' };
    }

    if (previousDirection === nextDirection && elapsedMinutes < this.sameDirectionCooldownMinutes) {
      return {
        allowed: false,
        reason: `same direction repeated after ${elapsedMinutes.toFixed(1)}m (<${this.sameDirectionCooldownMinutes}m cooldown)`
      };
    }

    if (previousDirection === nextDirection) {
      return { allowed: true, reason: 'same direction outside cooldown' };
    }

    if (elapsedMinutes >= this.reversalCooldownMinutes) {
      return {
        allowed: true,
        reason: `reversal outside cooldown (${elapsedMinutes.toFixed(1)}m >= ${this.reversalCooldownMinutes}m)`
      };
    }

    const absDelta = Math.abs(signal.delta_pct);
    const oddsSwingPp = Math.abs(signal.odds_now - previous.odds_now);
    const confidenceLift = signal.confidence - previous.confidence;
    const reinforcement = this.signalStore.countDistinctApprovedMarketsForAssetDirection(
      signal.matched_asset_id,
      nextDirection,
      this.reversalReinforcementMinutes
    );
    const whaleStrong = signal.whale_detected && (signal.whale_amount_usd || 0) >= 10_000;

    const strongMove = absDelta >= this.reversalMinDeltaPct;
    const strongOddsShift = oddsSwingPp >= this.reversalMinOddsSwingPp;
    const strongConfidenceLift = confidenceLift >= this.reversalMinConfidenceGain;
    const reinforced = reinforcement >= this.reversalMinDistinctMarkets;

    const fundamentalShift =
      (strongMove && strongOddsShift) ||
      (strongMove && reinforced) ||
      (strongMove && whaleStrong) ||
      (strongOddsShift && strongConfidenceLift && reinforced);

    if (!fundamentalShift) {
      return {
        allowed: false,
        reason:
          `reversal too weak (${elapsedMinutes.toFixed(1)}m): ` +
          `delta=${absDelta.toFixed(1)}% oddsSwing=${(oddsSwingPp * 100).toFixed(1)}pp ` +
          `reinforcement=${reinforcement}`
      };
    }

    return {
      allowed: true,
      reason:
        `fundamental reversal accepted (${elapsedMinutes.toFixed(1)}m): ` +
        `delta=${absDelta.toFixed(1)}% oddsSwing=${(oddsSwingPp * 100).toFixed(1)}pp ` +
        `reinforcement=${reinforcement}`
    };
  }

  private evaluatePushPerformanceGate(signal: GeneratedSignal): { allowed: boolean; reason: string } {
    if (!this.signalStore) {
      return { allowed: true, reason: 'signal store unavailable' };
    }

    const policy = this.signalStore.getPushPerformancePolicy(signal.matched_asset_id);
    if (!policy) {
      return { allowed: true, reason: 'no push-performance profile yet' };
    }

    if (policy.samples < 6) {
      return { allowed: true, reason: `insufficient samples (${policy.samples})` };
    }

    const absDelta = Math.abs(signal.delta_pct);
    const whaleStrong = signal.whale_detected && (signal.whale_amount_usd || 0) >= 20_000;
    const highConvictionOverride =
      signal.confidence >= (this.haMinConfidence + 15) &&
      absDelta >= 30 &&
      whaleStrong;
    const sourceFamily = String(signal.primary_source_family || '').trim();
    const sourcePerf = sourceFamily
      ? this.signalStore.getSourceFamilyPerformance(sourceFamily)
      : null;

    if (sourceFamily === 'crypto_proxy_market' && !highConvictionOverride) {
      return {
        allowed: false,
        reason: 'source family crypto_proxy_market requires extraordinary override'
      };
    }

    if (policy.gate === 'block') {
      if (highConvictionOverride) {
        return {
          allowed: true,
          reason:
            `block override: confidence=${signal.confidence}% delta=${absDelta.toFixed(1)}% ` +
            `whale=${signal.whale_amount_usd || 0}`
        };
      }
      return {
        allowed: false,
        reason:
          `asset gate=block (samples=${policy.samples}, hit30=${(policy.hitRate30m * 100).toFixed(0)}%, ` +
          `avg30=${policy.avgMove30m.toFixed(2)}%)`
      };
    }

    if (policy.gate === 'watch') {
      const strongCandidate =
        signal.confidence >= (this.haMinConfidence + 8) ||
        absDelta >= 25 ||
        whaleStrong;
      if (!strongCandidate) {
        return {
          allowed: false,
          reason:
            `asset gate=watch requires stronger setup (conf=${signal.confidence}%, delta=${absDelta.toFixed(1)}%)`
        };
      }
    }

    if (sourcePerf && sourcePerf.samples >= 6) {
      const poorFamily =
        sourcePerf.reliabilityScore < 0.25 ||
        sourcePerf.expectancyPct <= -1;
      if (poorFamily && !highConvictionOverride) {
        return {
          allowed: false,
          reason:
            `source family ${sourceFamily} weak ` +
            `(n=${sourcePerf.samples}, rel=${sourcePerf.reliabilityScore.toFixed(2)}, ` +
            `exp=${sourcePerf.expectancyPct.toFixed(2)}%)`
        };
      }

      const watchFamily =
        sourcePerf.reliabilityScore < 0.45 ||
        sourcePerf.expectancyPct < 0;
      if (watchFamily) {
        const strongFamilyCandidate =
          signal.confidence >= (this.haMinConfidence + 10) &&
          absDelta >= 25 &&
          (whaleStrong || signal.verification_source === 'claude');
        if (!strongFamilyCandidate) {
          return {
            allowed: false,
            reason:
              `source family ${sourceFamily} requires stronger setup ` +
              `(rel=${sourcePerf.reliabilityScore.toFixed(2)}, exp=${sourcePerf.expectancyPct.toFixed(2)}%)`
          };
        }
      }
    }

    const direction = this.getSignalDirection(signal);
    const directional = this.signalStore.getDirectionalPushPerformance(
      signal.matched_asset_id,
      direction,
      30
    );
    if (directional && directional.samples >= 5) {
      const poorDirection =
        directional.hitRate30m < 0.40 &&
        directional.avgMove30m <= 0;
      if (poorDirection && !highConvictionOverride) {
        return {
          allowed: false,
          reason:
            `directional edge weak (${direction} samples=${directional.samples}, ` +
            `hit30=${(directional.hitRate30m * 100).toFixed(0)}%, ` +
            `avg30=${directional.avgMove30m.toFixed(2)}%)`
        };
      }
    }

    return {
      allowed: true,
      reason:
        `asset gate=${policy.gate} ` +
        `(samples=${policy.samples}, hit30=${(policy.hitRate30m * 100).toFixed(0)}%)`
    };
  }

  private evaluateEvidenceGate(
    signal: GeneratedSignal,
    minConfidence: number,
    minEvidenceScore: number
  ): { allowed: boolean; reason: string } {
    if (!this.signalStore) {
      return { allowed: true, reason: 'signal store unavailable' };
    }

    const direction = this.getSignalDirection(signal);
    const absDelta = Math.abs(signal.delta_pct);
    const whaleAmount = signal.whale_amount_usd || 0;
    const reinforcement = this.signalStore.countDistinctApprovedMarketsForAssetDirection(
      signal.matched_asset_id,
      direction,
      90
    );

    let score = 0;
    if (signal.confidence >= minConfidence + 10) score += 1;
    if (absDelta >= 30) score += 1;
    if (whaleAmount >= 10_000) score += 2;
    else if (whaleAmount >= 5_000) score += 1;

    if (reinforcement >= 2) score += 2;
    if (reinforcement >= 3) score += 1;

    if (signal.verification_source === 'claude') score += 2;
    else if (signal.verification_source === 'guard' || signal.verification_source === 'guard_allowlist') score += 1;
    else if (signal.verification_source === 'fallback_guard') score += this.isTrustedFallbackGuard(signal) ? 0 : -1;

    const directionalPerf = this.signalStore.getDirectionalPushPerformance(
      signal.matched_asset_id,
      direction,
      30
    );
    if (directionalPerf && directionalPerf.samples >= 5) {
      if (directionalPerf.hitRate30m >= 0.56 && directionalPerf.avgMove30m > 0) {
        score += 2;
      } else if (directionalPerf.hitRate30m < 0.40 && directionalPerf.avgMove30m <= 0) {
        score -= 3;
      }
    }

    if (this.isMicroTimeboxMarket(signal.market_title)) {
      score -= 3;
    }

    if (signal.primary_source_family === 'crypto_proxy_market') {
      score -= 3;
    }

    if (typeof signal.catalyst_score === 'number') {
      if (signal.catalyst_score >= 75) score += 1;
      else if (signal.catalyst_score <= 45) score -= 1;
    }

    if (this.isCatalystConvergenceSignal(signal)) {
      const sourceTypes = new Set<string>();
      const reasoningLower = (signal.reasoning || '').toLowerCase();
      if (reasoningLower.includes('technical')) sourceTypes.add('technical');
      if (reasoningLower.includes('finviz') || reasoningLower.includes('volume spike')) sourceTypes.add('news');
      if (reasoningLower.includes('econ') || reasoningLower.includes('macro')) sourceTypes.add('macro');
      if (reasoningLower.includes('insider') || reasoningLower.includes('congressional')) sourceTypes.add('insider');
      if (reasoningLower.includes('price alert') || reasoningLower.includes('intraday')) sourceTypes.add('price');
      if (reasoningLower.includes('poly-confirms') || reasoningLower.includes('cross-source')) sourceTypes.add('polymarket');

      score += Math.min(4, sourceTypes.size);
      if (sourceTypes.has('polymarket')) score += 2;
    }

    const sourcePerf = signal.primary_source_family
      ? this.signalStore.getSourceFamilyPerformance(signal.primary_source_family)
      : null;
    if (sourcePerf && sourcePerf.samples >= 6) {
      if (sourcePerf.reliabilityScore >= 0.65 && sourcePerf.expectancyPct > 0.3) {
        score += 1;
      } else if (sourcePerf.reliabilityScore < 0.35 || sourcePerf.expectancyPct < -0.5) {
        score -= 2;
      }
    }

    const highConvictionOverride =
      signal.confidence >= (minConfidence + 18) &&
      absDelta >= 35 &&
      (whaleAmount >= 10_000 || reinforcement >= 3);

    if (score < minEvidenceScore && !highConvictionOverride) {
      return {
        allowed: false,
        reason:
          `score=${score}/${minEvidenceScore} ` +
          `(reinforcement=${reinforcement}, whale=${whaleAmount}, delta=${absDelta.toFixed(1)}%)`
      };
    }

    return {
      allowed: true,
      reason: `score=${score}/${minEvidenceScore} reinforcement=${reinforcement}`
    };
  }

  private evaluateExecutionReplayGate(signal: GeneratedSignal): { allowed: boolean; reason: string } {
    const gate = signal.execution_replay_gate || 'unknown';
    const samples = signal.execution_replay_samples || 0;
    const expectancy = signal.execution_replay_expectancy_pct || 0;
    const hitRate = signal.execution_replay_win_rate || 0;

    if (gate === 'block' && samples >= 6) {
      return {
        allowed: false,
        reason: `historical replay block (n=${samples}, hit30=${(hitRate * 100).toFixed(0)}%, exp=${expectancy.toFixed(2)}%)`
      };
    }

    if (gate === 'watch' && samples >= 6) {
      const strongOverride =
        signal.confidence >= this.haMinConfidence + 10 &&
        Math.abs(signal.delta_pct) >= 25 &&
        (signal.whale_amount_usd || 0) >= 10_000;
      if (!strongOverride) {
        return {
          allowed: false,
          reason: `replay watch requires stronger setup (n=${samples}, exp=${expectancy.toFixed(2)}%)`
        };
      }
    }

    return {
      allowed: true,
      reason: gate === 'unknown'
        ? 'no replay profile yet'
        : `${gate} (n=${samples}, exp=${expectancy.toFixed(2)}%)`
    };
  }

  /**
   * Premium Claude call — only fires when a signal is about to hit the trader's phone.
   * Provides final deep analysis with full signal context.
   */
  private async deepVerify(signal: GeneratedSignal): Promise<{
    verdict: 'approve' | 'reject';
    reason: string;
    confidence_adjustment: number;
  } | null> {
    if (!shouldDoDeepVerify()) {
      return null; // Proceed without deep-verify — guard already approved
    }
    const isBull = signal.suggested_action.toLowerCase().includes('bull');
    const oddsBefore = (signal.odds_before * 100).toFixed(1);
    const oddsNow = (signal.odds_now * 100).toFixed(1);
    const deltaSign = signal.delta_pct > 0 ? '+' : '';
    const momentumTag = signal.reasoning.match(/Momentum: (\w+)/)?.[1] ?? 'unknown';
    const sectorTag = signal.reasoning.match(/\[sector: .+?\]/)?.[0] ?? 'none';
    const reasoningTags = signal.reasoning.match(/\[[^\]]+\]/g) ?? [];
    const volTag = reasoningTags.find(tag => tag.toLowerCase().startsWith('[vol:')) ?? 'none';
    const macroTag = reasoningTags.find(tag => tag.toLowerCase().startsWith('[macro:')) ?? 'none';
    const futuresTag = reasoningTags.find(tag => tag.toLowerCase().startsWith('[futures:')) ?? 'none';
    const executionTag = reasoningTags.find(tag => tag.toLowerCase().startsWith('[execution:')) ?? 'none';
    const confidenceTags = reasoningTags
      .filter(tag => /^\[(timeframes|intel|news|macro|futures|vol|execution|sector)/i.test(tag))
      .join(' ');

    const volMatch = volTag.match(/\[vol:([^,\]]+),\s*VIX:([0-9.]+)\]/i);
    const volSummary = volMatch
      ? `VIX ${volMatch[2]} (${volMatch[1]} regime)`
      : 'no volatility tag';

    const macroMatch = macroTag.match(/\[macro:\s*([^,]+),\s*([-0-9]+)min away,\s*impact:([^\]]+)\]/i);
    const macroSummary = macroMatch
      ? `${macroMatch[1]} (${macroMatch[2]} min, impact ${macroMatch[3]})`
      : 'no active macro window';
    const futuresSummary = futuresTag === 'none'
      ? 'no futures confirmation tag'
      : futuresTag.replace(/^\[futures:\s*/i, '').replace(/\]$/, '');
    const executionSummary = executionTag === 'none'
      ? 'execution estimate unavailable'
      : executionTag.replace(/^\[execution:\s*/i, '').replace(/\]$/, '');

    // Query DB for live reinforcement data
    let reinforcingCount = 0;
    let newsSourceCount = 0;
    try {
      const { getDatabase } = await import('../storage/db.js');
      const db = getDatabase();
      const dirWord = isBull ? 'BULL' : 'BEAR';
      reinforcingCount = (db.prepare(`
        SELECT COUNT(*) as c FROM signals
        WHERE matched_asset_id = ?
          AND suggested_action LIKE '%' || ? || '%'
          AND timestamp >= datetime('now', '-24 hours')
          AND verification_status = 'approved'
      `).get(signal.matched_asset_id, dirWord) as any)?.c ?? 0;

      const asset = signal.matched_asset_name.toLowerCase();
      newsSourceCount = (db.prepare(`
        SELECT COUNT(DISTINCT account_handle) as c FROM tweet_snapshots
        WHERE scraped_at >= datetime('now', '-6 hours')
          AND LOWER(tweet_text) LIKE '%' || ? || '%'
      `).get(asset) as any)?.c ?? 0;
    } catch {}

    const prompt = `You are the final gatekeeper at a quantitative trading desk. A signal is about to be sent to a trader's phone for IMMEDIATE action on a leveraged X3 certificate (5-30 min holding period on Avanza, Swedish broker).

SIGNAL CONTEXT:
- Asset: ${signal.matched_asset_name} (${signal.matched_asset_id})
- Direction: ${isBull ? 'BULL (long)' : 'BEAR (short)'}
- Confidence: ${signal.confidence}% [tags: ${confidenceTags || 'none'}]
- Polymarket: "${signal.market_title}"
- Odds: ${oddsBefore}% -> ${oddsNow}% (${deltaSign}${signal.delta_pct.toFixed(1)}%)
- Momentum: ${momentumTag}
${signal.whale_detected ? `- Whale activity: $${(signal.whale_amount_usd || 0).toLocaleString()}` : '- No whale activity'}
- Reinforcing signals (24h): ${reinforcingCount} other approved signals for same asset + direction
- News corroboration: ${newsSourceCount} news sources mentioned ${signal.matched_asset_name} in last 6h
- Sector pattern: ${sectorTag}
- Futures: ${futuresSummary}
- Volatility regime: ${volSummary}
- Macro proximity: ${macroSummary}
- Execution feasibility: ${executionSummary}

TASK:
1) Approve only if causal mechanism is specific and strong.
2) Reject stale/noise setups unlikely to move within 30 minutes.
3) Reject if futures/vol/macro context clearly contradicts the trade.
4) Keep reason concrete and actionable for a trader.

Respond JSON ONLY, no other text:
{"verdict":"approve","reason":"1-2 sentences a trader can act on","confidence_adjustment":-10..10}
or
{"verdict":"reject","reason":"why not","confidence_adjustment":0}`;

    try {
      const result = await runLocalAiPrompt(prompt, {
        timeoutMs: 30000,
        maxBufferBytes: 1024 * 1024,
        usageContext: 'deep-verify-pre-push',
        logContext: 'deep-verify-pre-push'
      });
      if (result.ok) {
        const cleaned = result.stdout.trim().replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (parsed.verdict === 'approve' || parsed.verdict === 'reject') {
          return parsed;
        }
      }
    } catch {}
    return null; // Local AI unavailable — proceed without deep verification
  }
}
