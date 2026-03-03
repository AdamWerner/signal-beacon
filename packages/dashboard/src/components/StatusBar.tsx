import { useEffect, useState } from "react";
import { Zap, Activity, Clock, Database, AlertCircle } from "lucide-react";
import { HealthStatus } from "@/types";

export function StatusBar() {
  const [time, setTime] = useState(new Date());
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    const tickInterval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(tickInterval);
  }, []);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (res.ok) {
          setHealth(await res.json());
        }
      } catch {
        // Health fetch failed — scanner may be offline
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  const isActive = health?.status === 'healthy';
  const avanzaConnected = health?.avanza === 'connected';
  const newSignals = health?.scanner.signals.new ?? 0;
  const trackedMarkets = health?.scanner.markets.active ?? 0;
  const totalInstruments = health?.scanner.instruments.total ?? 0;

  return (
    <header className="h-10 border-b border-border bg-card flex items-center px-4 gap-6 text-xs font-mono shrink-0 relative overflow-hidden">
      {/* Scan line animation */}
      {isActive && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-bull/5 to-transparent animate-scan" />
        </div>
      )}

      {/* Scanner status */}
      <div className="flex items-center gap-2 z-10">
        <span className={`h-2 w-2 rounded-full ${isActive ? "bg-bull animate-pulse-glow" : "bg-destructive"}`} />
        <span className={isActive ? "text-bull" : "text-destructive"}>
          {health === null ? "Connecting..." : isActive ? "Scanner Active" : "Scanner Offline"}
        </span>
      </div>

      {/* Avanza status */}
      <div className="flex items-center gap-1.5 text-muted-foreground z-10">
        <Database className="h-3 w-3" />
        <span className={avanzaConnected ? "text-bull" : "text-muted-foreground"}>
          Avanza: {avanzaConnected ? "connected" : "not connected"}
        </span>
      </div>

      {/* Tracked markets */}
      <div className="flex items-center gap-1.5 text-muted-foreground z-10">
        <Activity className="h-3 w-3" />
        <span>{trackedMarkets} markets · {totalInstruments} instruments</span>
      </div>

      {/* New signals */}
      {newSignals > 0 && (
        <div className="flex items-center gap-1.5 z-10">
          <Zap className="h-3 w-3 text-bull" />
          <span className="text-bull">{newSignals} new signal{newSignals !== 1 ? "s" : ""}</span>
        </div>
      )}

      {/* Scan schedule */}
      {health && (
        <div className="flex items-center gap-1.5 text-muted-foreground z-10">
          <Clock className="h-3 w-3" />
          <span>{health.jobs.scan_cycle.schedule}</span>
        </div>
      )}

      <div className="ml-auto font-mono text-muted-foreground z-10">
        {time.toLocaleTimeString("en-US", { hour12: false })}
      </div>
    </header>
  );
}
