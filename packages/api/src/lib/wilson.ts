export function wilsonInterval(successes: number, total: number, z = 1.96): { lower: number; upper: number } {
  if (total === 0) {
    return { lower: 0, upper: 0 };
  }

  const phat = successes / total;
  const zSquared = z * z;
  const denom = 1 + (zSquared / total);
  const centre = phat + (zSquared / (2 * total));
  const margin = z * Math.sqrt((phat * (1 - phat) + (zSquared / (4 * total))) / total);

  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom)
  };
}
