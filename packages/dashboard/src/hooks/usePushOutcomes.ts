import { useEffect, useState } from 'react';
import type { PushOutcomesResponse } from '@/types';

const EMPTY: PushOutcomesResponse = {
  total: 0,
  evaluated: 0,
  wins: 0,
  losses: 0,
  pending: 0,
  winRate: null,
  avgMaxFavorable: null,
  avgMaxAdverse: null,
  avgTimeToPeak: null,
  byOrigin: {},
  outcomes: []
};

export function usePushOutcomes(days = 7) {
  const [data, setData] = useState<PushOutcomesResponse>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        const response = await fetch(`/api/push-outcomes?days=${days}`);
        if (!mounted) return;
        if (response.ok) {
          setData(await response.json());
        }
      } catch (error) {
        console.error('Failed to fetch push outcomes', error);
      } finally {
        if (mounted) setIsLoading(false);
      }
    };

    load();
    const interval = setInterval(load, 60000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [days]);

  return { data, isLoading };
}
