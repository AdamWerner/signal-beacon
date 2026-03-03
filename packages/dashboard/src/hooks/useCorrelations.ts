import { useEffect, useState } from 'react';
import { Correlation } from '@/types';

export const useCorrelations = () => {
  const [data, setData] = useState<Correlation[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/correlations');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();

        // Flatten API response: each market can have multiple mappings
        const transformed: Correlation[] = [];
        for (const entry of json) {
          for (const mapping of entry.mappings ?? []) {
            const polarity = mapping.polarity === 'context_dependent'
              ? 'CONTEXT'
              : (mapping.polarity === 'inverse' ? 'INVERSE' : 'DIRECT');

            // Derive instrument type from polarity + bulls/bears available
            const instrument_type = mapping.bull_count > 0 ? 'BULL' : 'BEAR';

            transformed.push({
              id: `${entry.market_condition_id}_${mapping.asset_id}`,
              polymarket: entry.market_title,
              polymarket_odds: 0, // not returned by API currently
              instrument: `${instrument_type} ${mapping.asset_name}`,
              instrument_type,
              polarity,
            });
          }
        }

        setData(transformed);
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
