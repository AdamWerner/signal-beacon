import { useEffect, useState } from 'react';
import { MarketWatch } from '@/types';

export const useMarkets = () => {
  const [data, setData] = useState<MarketWatch[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/markets');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // Transform API response to MarketWatch shape
        const transformed: MarketWatch[] = json.map((m: any) => ({
          id: String(m.id ?? m.condition_id),
          market: m.title ?? m.slug,
          current_odds: 0.5, // Populated from snapshots in future
          change_24h: 0,
          last_delta: 0,
          whale_alert: false,
          status: m.is_active ? 'active' : 'quiet',
          sparkline: [],
          history: [],
        }));

        setData(transformed);
      } catch (err) {
        console.error('Failed to fetch markets:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  return { data, isLoading };
};
