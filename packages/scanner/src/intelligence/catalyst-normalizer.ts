export type CatalystDirectionHint = 'bull' | 'bear' | 'mixed' | 'neutral';

export interface CatalystNormalizationInput {
  sourceType: 'polymarket' | 'news' | 'tweet' | 'macro' | 'whale' | 'technical' | 'insider' | 'volume';
  title: string;
  body?: string | null;
  assetId: string;
  assetName: string;
  hintedDirection?: CatalystDirectionHint;
  sourceWeight?: number;
  recentSimilarCount?: number;
}

export interface CatalystNormalizationResult {
  sourceFamily: string;
  eventType: string;
  directionHint: CatalystDirectionHint;
  horizonMinutes: number;
  causalStrength: number;
  noveltyScore: number;
  sourceQualityScore: number;
  normalizedSummary: string;
  isNoise: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Sentiment keywords for news contradiction detection (English + Swedish)
const BEARISH_KEYWORDS_EN = /\b(loser|lost|drop|fall|decline|cut|downgrade|warning|lawsuit|miss|weak|risk|fear|crash|loss)\b/gi;
const BULLISH_KEYWORDS_EN = /\b(winner|gain|rise|upgrade|beat|record|surge|strong|approval|contract|growth|profit)\b/gi;
const BEARISH_KEYWORDS_SV = /\b(f\u00f6rlorare|b\u00f6rsf\u00f6rlorare|tapp|nedg\u00e5ng|s\u00e4nk|varning|f\u00f6rlust|risk|svag|press|oro|kris|ras)\b/gi;
const BULLISH_KEYWORDS_SV = /\b(vinnare|uppg\u00e5ng|h\u00f6j|rekord|stark|genombrott|kontrakt|order|tillv\u00e4xt|vinst)\b/gi;

const EVENT_PATTERNS: Array<{
  family: string;
  eventType: string;
  horizonMinutes: number;
  strength: number;
  direction?: CatalystDirectionHint;
  pattern: RegExp;
}> = [
  { family: 'macro_rates', eventType: 'rate_policy', horizonMinutes: 180, strength: 0.86, pattern: /\b(fed|fomc|ecb|riksbank|rate hike|rate cut|inflation|cpi|ppi|payroll|nfp)\b/i },
  { family: 'macro_growth', eventType: 'growth_risk', horizonMinutes: 240, strength: 0.78, pattern: /\b(recession|gdp|jobless|consumer confidence|pmi)\b/i },
  { family: 'geopolitical_shipping', eventType: 'shipping_disruption', horizonMinutes: 180, strength: 0.88, pattern: /\b(red sea|suez|houthi|shipping lane|strait of hormuz)\b/i },
  { family: 'geopolitical_energy', eventType: 'energy_supply', horizonMinutes: 180, strength: 0.86, pattern: /\b(opec|oil|crude|lng|qatar|iran|israel|sanctions|hormuz)\b/i },
  { family: 'defense_geopolitical', eventType: 'defense_demand', horizonMinutes: 240, strength: 0.84, pattern: /\b(nato|missile|defense spending|air defense|fighter jet|ukraine|russia|taiwan|china)\b/i },
  { family: 'crypto_flow', eventType: 'crypto_flow', horizonMinutes: 60, strength: 0.76, pattern: /\b(bitcoin|ethereum|solana|etf|coinbase|sec crypto|token)\b/i },
  { family: 'tech_ai', eventType: 'technology_catalyst', horizonMinutes: 180, strength: 0.78, pattern: /\b(ai chip|gpu|nvidia|semiconductor|export control|data center|cloud)\b/i },
  { family: 'regulation_sector', eventType: 'regulatory_catalyst', horizonMinutes: 240, strength: 0.74, pattern: /\b(license|regulation|tariff|antitrust|ban|approval|legalization)\b/i },
  { family: 'swedish_macro_proxy', eventType: 'nordic_macro_proxy', horizonMinutes: 240, strength: 0.72, pattern: /\b(omx|swedish|sweden|stockholm|nordic|europe recession|ecb)\b/i },
  { family: 'news_breaking', eventType: 'breaking_news', horizonMinutes: 90, strength: 0.7, pattern: /\b(breaking|urgent|flash|developing)\b/i }
];

const NOISE_PATTERNS = [
  /\b(podcast|album|song|streamer|youtube|celebrity|joe rogan|uponly)\b/i,
  /\b(up or down)\b.+\b(et)\b/i,
  /\bscore|vs\.|match|ahl|nba|nfl|transfer\b/i
];

export class CatalystNormalizer {
  normalize(input: CatalystNormalizationInput): CatalystNormalizationResult {
    const text = `${input.title} ${input.body || ''}`.trim();
    const classificationText = input.sourceType === 'polymarket'
      ? String(input.title || '').trim()
      : text;
    const lowered = classificationText.toLowerCase();
    const baseQuality = input.sourceType === 'macro'
      ? 0.92
      : input.sourceType === 'whale'
        ? 0.82
        : input.sourceType === 'technical'
          ? 0.78
          : input.sourceType === 'insider'
            ? 0.8
            : input.sourceType === 'volume'
              ? 0.74
        : input.sourceType === 'polymarket'
          ? 0.75
          : input.sourceType === 'news'
            ? 0.72
            : 0.68;

    if (input.sourceType === 'technical') {
      const directionHint = input.hintedDirection || this.inferDirection(lowered, input.hintedDirection);
      return {
        sourceFamily: 'technical_breakout',
        eventType: 'technical_breakout',
        directionHint,
        horizonMinutes: 60,
        causalStrength: clamp(0.76 + ((input.sourceWeight || 1) - 1) * 0.08, 0.25, 0.95),
        noveltyScore: Math.max(0.2, 0.8 - Math.min(0.3, (input.recentSimilarCount || 0) * 0.08)),
        sourceQualityScore: baseQuality,
        normalizedSummary: this.buildSummary(input.assetName, 'technical_breakout', directionHint, classificationText),
        isNoise: false
      };
    }

    if (input.sourceType === 'insider') {
      const directionHint = input.hintedDirection || this.inferDirection(lowered, input.hintedDirection);
      return {
        sourceFamily: 'insider_flow',
        eventType: 'insider_trade',
        directionHint,
        horizonMinutes: 240,
        causalStrength: clamp(0.82 + ((input.sourceWeight || 1) - 1) * 0.08, 0.25, 0.95),
        noveltyScore: Math.max(0.2, 0.82 - Math.min(0.3, (input.recentSimilarCount || 0) * 0.08)),
        sourceQualityScore: baseQuality,
        normalizedSummary: this.buildSummary(input.assetName, 'insider_flow', directionHint, classificationText),
        isNoise: false
      };
    }

    if (input.sourceType === 'volume') {
      const directionHint = input.hintedDirection || this.inferDirection(lowered, input.hintedDirection);
      return {
        sourceFamily: 'volume_momentum',
        eventType: 'volume_spike',
        directionHint,
        horizonMinutes: 90,
        causalStrength: clamp(0.72 + ((input.sourceWeight || 1) - 1) * 0.08, 0.25, 0.95),
        noveltyScore: Math.max(0.18, 0.78 - Math.min(0.28, (input.recentSimilarCount || 0) * 0.08)),
        sourceQualityScore: baseQuality,
        normalizedSummary: this.buildSummary(input.assetName, 'volume_momentum', directionHint, classificationText),
        isNoise: false
      };
    }

    const proxyFamily = input.sourceType === 'polymarket'
      ? this.getProxyMarketFamily(input.assetId, classificationText)
      : null;

    if (proxyFamily) {
      const recentSimilar = input.recentSimilarCount || 0;
      return {
        sourceFamily: proxyFamily,
        eventType: 'proxy_price_ladder',
        directionHint: input.hintedDirection || this.inferDirection(lowered, input.hintedDirection),
        horizonMinutes: 45,
        causalStrength: 0.24,
        noveltyScore: Math.max(0.08, 0.45 - Math.min(0.28, recentSimilar * 0.05)),
        sourceQualityScore: Math.max(0.2, baseQuality - 0.12),
        normalizedSummary: `crypto proxy market for ${input.assetName}: ${this.compactText(classificationText)}`,
        isNoise: false
      };
    }

    if (NOISE_PATTERNS.some(pattern => pattern.test(classificationText))) {
      return {
        sourceFamily: `${input.sourceType}_noise`,
        eventType: 'noise',
        directionHint: 'neutral',
        horizonMinutes: 30,
        causalStrength: 0.15,
        noveltyScore: 0.2,
        sourceQualityScore: baseQuality,
        normalizedSummary: `${input.sourceType} noise filtered for ${input.assetName}: ${this.compactText(classificationText)}`,
        isNoise: true
      };
    }

    const matched = EVENT_PATTERNS.find(rule => rule.pattern.test(classificationText));
    const sourceFamily = matched?.family || `${input.sourceType}_generic`;
    const eventType = matched?.eventType || 'generic_catalyst';
    const directionHint = input.hintedDirection || matched?.direction || this.inferDirection(lowered, input.hintedDirection);
    let causalStrength = Math.max(0.25, Math.min(0.95, (matched?.strength || 0.6) + ((input.sourceWeight || 1) - 1) * 0.08));
    const noveltyPenalty = Math.min(0.35, (input.recentSimilarCount || 0) * 0.08);
    const noveltyScore = Math.max(0.1, 0.9 - noveltyPenalty);
    const sourceQualityScore = Math.max(0.2, Math.min(0.98, baseQuality + ((input.sourceWeight || 1) - 1) * 0.05));

    // Detect news sentiment contradiction: news body language opposes the hinted direction.
    // e.g. bearish article ("börsförlorarna") counted as supporting a BULL signal → penalize.
    let contradictionTag = '';
    if (input.sourceType === 'news' && input.hintedDirection && input.hintedDirection !== 'mixed' && input.hintedDirection !== 'neutral') {
      const combined = `${input.title || ''} ${input.body || ''}`;
      const bearishHits = (combined.match(BEARISH_KEYWORDS_EN) || []).length
                        + (combined.match(BEARISH_KEYWORDS_SV) || []).length;
      const bullishHits = (combined.match(BULLISH_KEYWORDS_EN) || []).length
                        + (combined.match(BULLISH_KEYWORDS_SV) || []).length;
      if (input.hintedDirection === 'bull' && bearishHits > bullishHits + 1) {
        causalStrength = causalStrength * 0.4;
        contradictionTag = ' [news-contradicts-direction]';
      } else if (input.hintedDirection === 'bear' && bullishHits > bearishHits + 1) {
        causalStrength = causalStrength * 0.4;
        contradictionTag = ' [news-contradicts-direction]';
      }
    }

    return {
      sourceFamily,
      eventType,
      directionHint,
      horizonMinutes: matched?.horizonMinutes || 120,
      causalStrength,
      noveltyScore,
      sourceQualityScore,
      normalizedSummary: this.buildSummary(input.assetName, sourceFamily, directionHint, classificationText) + contradictionTag,
      isNoise: false
    };
  }

  private inferDirection(text: string, hintedDirection?: CatalystDirectionHint): CatalystDirectionHint {
    if (hintedDirection) return hintedDirection;
    if (/\b(cut|approval|restart|beat|surge|expand|growth|bull|up)\b/.test(text)) return 'bull';
    if (/\b(hike|ban|war|strike|miss|bear|down|collapse|revoke)\b/.test(text)) return 'bear';
    return 'mixed';
  }

  private buildSummary(assetName: string, family: string, direction: CatalystDirectionHint, text: string): string {
    const head = this.compactText(text);
    return `${family} ${direction.toUpperCase()} catalyst for ${assetName}: ${head}`;
  }

  private compactText(text: string): string {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > 96 ? `${trimmed.slice(0, 93)}...` : trimmed;
  }

  private getProxyMarketFamily(assetId: string, text: string): string | null {
    const normalized = text.toLowerCase();
    if (assetId === 'crypto-coinbase' && this.isCryptoProxyMarket(normalized)) {
      return 'crypto_proxy_market';
    }
    if (assetId.startsWith('oil-') && this.isCommodityProxyMarket(normalized)) {
      return 'commodity_proxy_market';
    }
    if (['ev-tesla', 'sp500', 'nasdaq100', 'omx30'].includes(assetId) && this.isEquityProxyMarket(normalized)) {
      return 'asset_proxy_market';
    }
    return null;
  }

  private isCryptoProxyMarket(normalized: string): boolean {
    if (!/\b(bitcoin|ethereum|solana|btc|eth|gas price|gwei)\b/.test(normalized)) {
      return false;
    }

    if (/\bup or down\b/.test(normalized) && /\b(et|eastern)\b/.test(normalized)) {
      return true;
    }

    if (/\baverage monthly\b.+\b(gas price|gwei)\b/.test(normalized)) {
      return true;
    }

    return (
      /\bprice of\b.*\b(bitcoin|ethereum|solana|btc|eth)\b/.test(normalized) ||
      /\b(bitcoin|ethereum|solana|btc|eth)\b.*\b(above|below|between|reach|hit|over|under|dip to)\b/.test(normalized) ||
      /\$\d[\d,]*\s*-\s*\$\d[\d,]*/.test(normalized)
    );
  }

  private isCommodityProxyMarket(normalized: string): boolean {
    if (!/\b(crude oil|oil|wti|brent|cl)\b/.test(normalized)) {
      return false;
    }
    return this.hasPriceLadderPattern(normalized);
  }

  private isEquityProxyMarket(normalized: string): boolean {
    if (!/\b(tesla|tsla|s&p 500|sp500|nasdaq|omx)\b/.test(normalized)) {
      return false;
    }
    return this.hasPriceLadderPattern(normalized) || /\bclose above|close below|dip to\b/.test(normalized);
  }

  private hasPriceLadderPattern(normalized: string): boolean {
    return (
      /\bprice of\b/.test(normalized) ||
      /\b(above|below|between|reach|hit|over|under|dip to)\b/.test(normalized) && /\$\d/.test(normalized) ||
      /\$\d[\d,]*\s*-\s*\$\d[\d,]*/.test(normalized)
    );
  }
}
