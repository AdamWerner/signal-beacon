import { useEffect, useState } from 'react';
import { MarketWatch } from '@/types';

export const useMarkets = () => {
  const [data, setData] = useState<MarketWatch[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/markets/trending?limit=20');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        const transformed = json.map((m: any) => ({
          id: m.condition_id,
          market: m.title ?? m.condition_id,
          current_odds: m.current_odds ?? 0.5,
          change_24h: m.change_24h ?? 0,
          last_delta: m.last_delta ?? 0,
          whale_alert: m.whale_alert ?? false,
          status: Math.abs(m.last_delta ?? 0) >= 10 ? 'alert' : m.current_odds > 0 ? 'active' : 'quiet',
          sparkline: m.sparkline ?? [],
          history: (m.sparkline ?? []).map((v: number, i: number) => ({ time: String(i), odds: v })),
          mapped_assets: m.mapped_assets ?? [],
        }));

        setData(transformed);
      } catch (err) {
        console.error('Failed to fetch trending markets:', err);
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
