import { useEffect, useState } from 'react';

export interface CorrelationMapping {
  asset_id: string;
  asset_name: string;
  polarity: string;
  explanation: string;
  bull_count: number;
  bear_count: number;
  signal_count_48h: number;
  avg_confidence: number;
  best_confidence: number;
  best_signal_id: string | null;
}

export interface CorrelationMarket {
  market_condition_id: string;
  market_title: string;
  market_slug: string;
  category: string;
  current_odds: number | null;
  relevance_score: number;
  mappings: CorrelationMapping[];
}

export interface CorrelationsData {
  categories: Record<string, CorrelationMarket[]>;
  total_markets: number;
  total_with_signals: number;
}

export const useCorrelations = () => {
  const [data, setData] = useState<CorrelationsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/correlations');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setData(json);
      } catch (err) {
        console.error('Failed to fetch correlations:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  return { data, isLoading };
};
