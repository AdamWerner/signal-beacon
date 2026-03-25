import { useEffect, useState } from 'react';
import { Signal } from '@/types';

interface SignalFilters {
  hours?: number;
  minConfidence?: number;
  limit?: number;
  origin?: 'polymarket' | 'catalyst_convergence';
}

export const useSignals = (filters: SignalFilters = {}) => {
  const [data, setData] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const params = new URLSearchParams();
        if (filters.hours) params.set('hours', String(filters.hours));
        if (filters.minConfidence !== undefined) params.set('min_confidence', String(filters.minConfidence));
        if (filters.limit) params.set('limit', String(filters.limit));
        if (filters.origin) params.set('origin', filters.origin);
        const query = params.toString() ? `?${params}` : '';
        const res = await fetch(`/api/signals${query}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setData(json);
      } catch (err) {
        console.error('Failed to fetch signals:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.hours, filters.minConfidence, filters.limit, filters.origin]);

  return { data, isLoading };
};
