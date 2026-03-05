import { useEffect, useState } from 'react';
import { Signal } from '@/types';

export const useTopSignals = () => {
  const [data, setData] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [includeUnverified, setIncludeUnverified] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(`/api/signals/top?include_unverified=${includeUnverified ? 'true' : 'false'}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setData(json);
      } catch (err) {
        console.error('Failed to fetch top signals:', err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 60000); // refresh every 60s (cached 15min server-side)
    return () => clearInterval(interval);
  }, [includeUnverified]);

  return { data, isLoading, includeUnverified, setIncludeUnverified };
};
