import { useEffect, useState } from 'react';

interface StreamingHealthPayload {
  enabled: boolean;
  db: Array<{ component: string; status: string; details: string; last_message_at: string }>;
  runtime: Array<{ component: string; status: string; details: string; lastMessageAt: number }>;
}

export const useStreamingHealth = () => {
  const [data, setData] = useState<StreamingHealthPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/streaming/health');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setData(json);
      } catch {
        setData(null);
      } finally {
        setIsLoading(false);
      }
    };

    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, []);

  return { data, isLoading };
};

