import { useEffect, useState } from 'react';
import { Briefing } from '@/types';

export function useBriefings(limit = 8) {
  const [data, setData] = useState<Briefing[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const fetchData = async () => {
      try {
        const res = await fetch(`/api/briefing/recent?limit=${limit}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (mounted) setData(Array.isArray(json) ? json : []);
      } catch (error) {
        console.error('Failed to fetch briefings:', error);
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
  }, [limit]);

  return { data, isLoading };
}
