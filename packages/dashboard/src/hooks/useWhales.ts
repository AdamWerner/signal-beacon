import { useEffect, useState } from 'react';
import { WhaleEntry } from '@/types';

export const useWhales = () => {
  const [data, setData] = useState<WhaleEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/whales');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // Transform API response to WhaleEntry shape
        const transformed: WhaleEntry[] = json.map((w: any) => ({
          id: String(w.id),
          timestamp: w.timestamp,
          market: w.market_title || (w.market_condition_id?.substring(0, 12) + '…'),
          amount: w.size_usd,
          direction: w.side as 'YES' | 'NO',
          price_at_trade: w.price_at_trade,
        }));

        setData(transformed);
      } catch (err) {
        console.error('Failed to fetch whale events:', err);
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
