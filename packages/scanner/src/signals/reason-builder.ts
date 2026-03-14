import { GeneratedSignal } from './types.js';

const BOILERPLATE_REASONS = new Set([
  'Approved by explicit ontology keyword match',
  'Known entity-asset relationship validated',
  'Entity relevance below configured threshold'
]);

export function buildHumanReason(signal: GeneratedSignal, recentSignals?: any[]): string {
  const parts: string[] = [];

  const marketShort = signal.market_title
    .replace(/^Will /, '')
    .replace(/\?$/, '')
    .substring(0, 60);
  const direction = signal.suggested_action.toLowerCase().includes('bull') ? 'UP' : 'DOWN';
  parts.push(`${marketShort} -> ${signal.matched_asset_name} likely ${direction}`);

  if (signal.verification_reason && !BOILERPLATE_REASONS.has(signal.verification_reason)) {
    parts.push(signal.verification_reason);
  }

  const evidence: string[] = [];
  if (signal.whale_detected && signal.whale_amount_usd) {
    evidence.push(`whale $${(signal.whale_amount_usd / 1000).toFixed(0)}K`);
  }
  const deltaSign = signal.delta_pct > 0 ? '+' : '';
  evidence.push(
    `odds ${(signal.odds_before * 100).toFixed(0)}%->${(signal.odds_now * 100).toFixed(0)}% ` +
    `(${deltaSign}${signal.delta_pct.toFixed(0)}%)`
  );

  if (evidence.length > 0) {
    parts.push(evidence.join(' | '));
  }

  if (recentSignals && recentSignals.length > 1) {
    parts.push(`${Math.min(recentSignals.length, 6)} reinforcing signals in recent window`);
  }

  return parts.join('\n').substring(0, 255);
}
