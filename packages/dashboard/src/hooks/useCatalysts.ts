import { useEffect, useState } from 'react';

export interface CatalystRow {
  id: number;
  source_type: string;
  source_family: string;
  event_type: string;
  title: string;
  normalized_summary: string;
  asset_ids: string[];
  direction_hint: string | null;
  causal_strength: number;
  novelty_score: number;
  source_quality_score: number;
  created_at: string;
}

export interface SourceDiagnosticRow {
  source_family: string;
  samples: number;
  hit_rate_30m: number;
  hit_rate_60m: number;
  expectancy_pct: number;
  reliability_score: number;
}

export function useCatalysts() {
  const [recent, setRecent] = useState<CatalystRow[]>([]);
  const [diagnostics, setDiagnostics] = useState<SourceDiagnosticRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const fetchData = async () => {
      try {
        const [recentRes, diagnosticsRes] = await Promise.all([
          fetch('/api/catalysts/recent?hours=24&limit=8'),
          fetch('/api/catalysts/diagnostics?limit=6')
        ]);

        if (!mounted) return;
        if (recentRes.ok) {
          setRecent(await recentRes.json());
        }
        if (diagnosticsRes.ok) {
          setDiagnostics(await diagnosticsRes.json());
        }
      } catch (error) {
        console.error('Failed to fetch catalysts', error);
      } finally {
        if (mounted) setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return { recent, diagnostics, isLoading };
}
