export interface MomentumResult {
  trend: 'accelerating' | 'steady' | 'decelerating' | 'reverting' | 'insufficient_data';
  consistency: number;    // 0-1, how many recent snapshots agree with current direction
  cyclesInDirection: number;  // How many consecutive cycles the odds moved this way
  boost: number;          // Confidence adjustment: -10 to +12
}

/**
 * Analyze the last N snapshots for a market to determine if the odds move
 * is a sustained trend or a one-off spike.
 */
export function analyzeMomentum(
  snapshots: Array<{ odds_yes: number; timestamp: string }>,
  currentDirection: 'up' | 'down'
): MomentumResult {
  if (snapshots.length < 3) {
    return { trend: 'insufficient_data', consistency: 0, cyclesInDirection: 0, boost: 0 };
  }

  // Sort oldest to newest
  const sorted = [...snapshots].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Check consecutive moves in the signal's direction
  let cyclesInDirection = 0;
  for (let i = sorted.length - 1; i > 0; i--) {
    const delta = sorted[i].odds_yes - sorted[i - 1].odds_yes;
    const movedRight = currentDirection === 'up' ? delta > 0.001 : delta < -0.001;
    if (movedRight) {
      cyclesInDirection++;
    } else {
      break;
    }
  }

  // Consistency: what fraction of last 6 intervals moved in the right direction?
  const lookback = sorted.slice(-7);
  let agreeing = 0;
  for (let i = 1; i < lookback.length; i++) {
    const delta = lookback[i].odds_yes - lookback[i - 1].odds_yes;
    const movedRight = currentDirection === 'up' ? delta > 0 : delta < 0;
    if (movedRight) agreeing++;
  }
  const consistency = agreeing / Math.max(lookback.length - 1, 1);

  // Check if the move is accelerating (later deltas bigger than earlier)
  const recentDeltas = [];
  for (let i = Math.max(1, sorted.length - 4); i < sorted.length; i++) {
    recentDeltas.push(Math.abs(sorted[i].odds_yes - sorted[i - 1].odds_yes));
  }
  const accelerating = recentDeltas.length >= 2 &&
    recentDeltas[recentDeltas.length - 1] > recentDeltas[0] * 1.3;

  let trend: MomentumResult['trend'];
  let boost: number;

  if (cyclesInDirection >= 3 && consistency >= 0.7) {
    trend = accelerating ? 'accelerating' : 'steady';
    boost = accelerating ? 12 : 8;
  } else if (cyclesInDirection >= 2 && consistency >= 0.5) {
    trend = 'steady';
    boost = 5;
  } else if (cyclesInDirection <= 1 && consistency < 0.4) {
    trend = 'reverting';
    boost = -10; // Penalize — this might be a spike that's already fading
  } else {
    trend = 'decelerating';
    boost = 0;
  }

  return { trend, consistency, cyclesInDirection, boost };
}
