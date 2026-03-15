import { isMarketOpen, isPreMarketWindow } from '../intelligence/trading-hours.js';

export type AiBudgetMode = 'active' | 'briefing_batch' | 'dormant';

function isWeekend(): boolean {
  const now = new Date();
  const stockholmStr = now.toLocaleString('en-US', { timeZone: 'Europe/Stockholm' });
  const s = new Date(stockholmStr);
  return s.getDay() === 0 || s.getDay() === 6;
}

/**
 * Determines whether AI calls should be made right now.
 *
 * ACTIVE: During market hours. Deep-verify before push is allowed.
 * BRIEFING_BATCH: Pre-market window. One big batch call for ranking + briefing.
 * DORMANT: Nights, weekends, between sessions. ZERO AI calls.
 */
export function getAiBudgetMode(): AiBudgetMode {
  if (isWeekend()) return 'dormant';

  // Pre-market windows: batch mode (08:45-09:00 CET for Swedish, 15:15-15:30 CET for US)
  if (isPreMarketWindow('swedish') || isPreMarketWindow('us')) {
    return 'briefing_batch';
  }

  // Market hours: active mode
  if (isMarketOpen('swedish') || isMarketOpen('us')) {
    return 'active';
  }

  // Everything else: dormant
  return 'dormant';
}

/**
 * Should we call Claude for AI ranking this cycle?
 * Only during briefing_batch or active mode.
 */
export function shouldDoAiRanking(): boolean {
  const mode = getAiBudgetMode();
  return mode === 'active' || mode === 'briefing_batch';
}

/**
 * Should we call Claude for deep-verify before a push?
 * Only during active mode (we're about to push to phone).
 */
export function shouldDoDeepVerify(): boolean {
  return getAiBudgetMode() === 'active';
}

/**
 * Should we call Claude for tweet/news AI processing?
 * Only during briefing_batch (just before briefing generation).
 */
export function shouldDoTweetProcessing(): boolean {
  return getAiBudgetMode() === 'briefing_batch';
}

/**
 * Should we call Claude for morning briefing generation?
 * Only during briefing_batch.
 */
export function shouldDoMorningBriefing(): boolean {
  return getAiBudgetMode() === 'briefing_batch';
}
