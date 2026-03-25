import { useEffect, useState } from 'react';
import type { PushDiagnostics } from '@/types';

const EMPTY: PushDiagnostics = {
  summary: {
    total: 0,
    by_origin: {
      polymarket: 0,
      catalyst: 0,
      hybrid: 0
    },
    top_blocks: {}
  },
  signals: []
};

export function usePushDiagnostics() {
  const [data, setData] = useState<PushDiagnostics>(EMPTY);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        const response = await fetch('/api/signals/push-diagnostics');
        if (!mounted) return;
        if (response.ok) {
          setData(await response.json());
        }
      } catch (error) {
        console.error('Failed to fetch push diagnostics', error);
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
  }, []);

  return { data, isLoading };
}
