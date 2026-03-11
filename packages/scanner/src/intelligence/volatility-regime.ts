export type VolRegime = 'low' | 'normal' | 'high' | 'extreme';

export class VolatilityRegimeDetector {
  private cachedRegime: { regime: VolRegime; vix: number; updatedAt: number } | null = null;

  async getRegime(): Promise<{ regime: VolRegime; vix: number }> {
    if (this.cachedRegime && Date.now() - this.cachedRegime.updatedAt < 10 * 60 * 1000) {
      return { regime: this.cachedRegime.regime, vix: this.cachedRegime.vix };
    }

    const vix = await this.fetchVix();
    let regime: VolRegime;
    if (vix < 13) {
      regime = 'low';
    } else if (vix < 20) {
      regime = 'normal';
    } else if (vix < 30) {
      regime = 'high';
    } else {
      regime = 'extreme';
    }

    this.cachedRegime = { regime, vix, updatedAt: Date.now() };
    return { regime, vix };
  }

  getConfidenceAdjustment(regime: VolRegime): number {
    switch (regime) {
      case 'low':
        return -8;
      case 'normal':
        return 0;
      case 'high':
        return 5;
      case 'extreme':
        return -5;
      default:
        return 0;
    }
  }

  private async fetchVix(): Promise<number> {
    try {
      const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d';
      const response = await fetch(url, {
        headers: { 'User-Agent': 'PolySignal/1.0' },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        return 18;
      }

      const data = await response.json() as any;
      const close = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if (Array.isArray(close)) {
        const lastClose = close
          .filter((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0)
          .pop();
        if (typeof lastClose === 'number') {
          return lastClose;
        }
      }
    } catch {
      // Default fallback below.
    }

    return 18;
  }
}

