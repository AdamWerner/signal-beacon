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
  abs_change_pp?: number; // absolute percentage-point change (odds_now - odds_before)
  odds_now?: number;
  odds_before?: number;
}): number {
  let score = 0;

  // Magnitude of relative odds change (max 30 points)
  const absDelta = Math.abs(params.delta_pct);
  if (absDelta >= 100) {
    score += 30;
  } else if (absDelta >= 50) {
    score += 25;
  } else if (absDelta >= 30) {
    score += 20;
  } else if (absDelta >= 15) {
    score += 15;
  } else if (absDelta >= 8) {
    score += 10;
  } else if (absDelta >= 3) {
    score += 5;
  }

  // Absolute percentage-point change bonus (max 25 points)
  // A 2%→20% move (+18pp) is far more actionable than 50%→55% (+5pp)
  const absChange = params.abs_change_pp !== undefined ? Math.abs(params.abs_change_pp) : 0;
  if (absChange >= 0.20) {
    score += 25;
  } else if (absChange >= 0.10) {
    score += 18;
  } else if (absChange >= 0.05) {
    score += 10;
  } else if (absChange >= 0.02) {
    score += 4;
  }

  // Whale activity (max 20 points) — any whale detection gets base credit
  if (params.whale_detected) {
    score += 10; // base bonus just for whale presence
    if (params.whale_usd) {
      if (params.whale_usd >= 100000) {
        score += 10;
      } else if (params.whale_usd >= 50000) {
        score += 7;
      } else if (params.whale_usd >= 10000) {
        score += 4;
      }
    }
  }

  // Time compression (max 18 points) — ultra-fresh signals get full credit; stale moves lose value fast
  if (params.time_window_minutes <= 10) {
    score += 18;
  } else if (params.time_window_minutes <= 20) {
    score += 13;
  } else if (params.time_window_minutes <= 30) {
    score += 8;
  } else if (params.time_window_minutes <= 60) {
    score += 3;
  }

  // Market quality — volume tiers (max 15 points)
  // Quant-grade: only high-liquidity markets get full credit
  if (params.volume !== undefined) {
    if (params.volume > 10_000_000) {
      score += 15;
    } else if (params.volume > 5_000_000) {
      score += 12;
    } else if (params.volume > 1_000_000) {
      score += 8;
    } else if (params.volume > 500_000) {
      score += 4;
    } else if (params.volume > 100_000) {
      score += 1; // Barely registers
    }
    // Below 100K: +0 (noise market)
    if (params.volume < 50_000) {
      score -= 5; // Active penalty for illiquid markets
    }
  }

  // Odds-zone actionability bonus
  // Signals in the "decision zone" (25-75%) are more actionable than near-certainty moves
  if (params.odds_now !== undefined) {
    const oddsNow = params.odds_now;
    if (oddsNow >= 0.25 && oddsNow <= 0.75) {
      score += 8; // Sweet spot — market is undecided, move is meaningful
    } else if (oddsNow >= 0.15 && oddsNow <= 0.85) {
      score += 3; // Moderate zone
    }
    // Outside 15-85%: no bonus (too close to resolved)
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

  // Penalty for low-probability markets (peak odds < 10% or < 20%).
  // A market at 3% odds is barely real — big relative moves are still noise.
  if (params.abs_change_pp !== undefined) {
    const maxOdds = Math.max(
      typeof params.odds_now === 'number' ? params.odds_now : 1,
      typeof params.odds_before === 'number' ? params.odds_before : 1
    );
    if (maxOdds < 0.10) {
      score -= 20; // Heavy penalty — fringe market
    } else if (maxOdds < 0.20) {
      score -= 10; // Moderate penalty — still speculative
    }
  }

  // Cap at 92 — nothing in a prediction market warrants absolute certainty
  return Math.min(Math.max(score, 0), 92);
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
