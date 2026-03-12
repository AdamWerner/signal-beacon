import { useEffect, useState } from 'react';

interface FusionDecisionRow {
  timestamp: string;
  symbol: string;
  decision: string;
  p_hat: number;
  expectancy_hat_pct: number;
  suppress_reasons?: string[];
  reasons?: string[];
}

export const useFusionDecisions = () => {
  const [decisions, setDecisions] = useState<FusionDecisionRow[]>([]);
  const [suppressed, setSuppressed] = useState<FusionDecisionRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [dRes, sRes] = await Promise.all([
          fetch('/api/fusion/decisions?limit=10'),
          fetch('/api/fusion/suppressed?limit=10')
        ]);

        const nextDecisions = dRes.ok ? await dRes.json() : [];
        const nextSuppressed = sRes.ok ? await sRes.json() : [];
        setDecisions(Array.isArray(nextDecisions) ? nextDecisions : []);
        setSuppressed(Array.isArray(nextSuppressed) ? nextSuppressed : []);
      } catch {
        setDecisions([]);
        setSuppressed([]);
      } finally {
        setIsLoading(false);
      }
    };

    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);

  return { decisions, suppressed, isLoading };
};

