/**
 * Calculate confidence score for a signal (0-100)
 */
export function calculateConfidence(params: {
  delta_pct: number;
  time_window_minutes: number;
  whale_detected: boolean;
  whale_usd?: number;
  volume?: number;
  relevance_score?: number;
}): number {
  let score = 0;

  // Magnitude of odds change (max 30 points)
  const absDelta = Math.abs(params.delta_pct);
  if (absDelta >= 20) {
    score += 30;
  } else if (absDelta >= 15) {
    score += 25;
  } else if (absDelta >= 10) {
    score += 20;
  } else if (absDelta >= 8) {
    score += 15;
  } else if (absDelta >= 5) {
    score += 10;
  }

  // Whale activity (max 25 points)
  if (params.whale_detected && params.whale_usd) {
    if (params.whale_usd >= 100000) {
      score += 25;
    } else if (params.whale_usd >= 50000) {
      score += 20;
    } else if (params.whale_usd >= 25000) {
      score += 15;
    }
  }

  // Time compression (max 15 points) - faster moves score higher
  if (params.time_window_minutes <= 15) {
    score += 15;
  } else if (params.time_window_minutes <= 30) {
    score += 12;
  } else if (params.time_window_minutes <= 60) {
    score += 8;
  }

  // Market quality (max 15 points)
  if (params.volume !== undefined) {
    if (params.volume > 1000000) {
      score += 15;
    } else if (params.volume > 500000) {
      score += 10;
    } else if (params.volume > 100000) {
      score += 5;
    }
  }

  // Ontology confidence (max 15 points)
  if (params.relevance_score !== undefined) {
    if (params.relevance_score > 0.8) {
      score += 15;
    } else if (params.relevance_score > 0.6) {
      score += 10;
    } else if (params.relevance_score > 0.4) {
      score += 5;
    }
  }

  // Cap at 100
  return Math.min(score, 100);
}

/**
 * Generate confidence level label
 */
export function getConfidenceLabel(score: number): string {
  if (score >= 80) return 'VERY HIGH';
  if (score >= 65) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  if (score >= 35) return 'LOW';
  return 'VERY LOW';
}
