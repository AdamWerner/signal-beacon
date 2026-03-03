import { useEffect, useState } from "react";
import { Zap, Activity, Clock } from "lucide-react";
import { signals } from "@/data/mockData";

export function StatusBar() {
  const [time, setTime] = useState(new Date());
  const active = true;
  const activeSignals = signals.filter((s) => s.status === "new").length;

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="h-10 border-b border-border bg-card flex items-center px-4 gap-6 text-xs font-mono shrink-0 relative overflow-hidden">
      {/* Scan line animation */}
      {active && (
        <div className="absolute inset-0 pointer-events-none">
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-bull/5 to-transparent animate-scan" />
        </div>
      )}

      <div className="flex items-center gap-2 z-10">
        <span className={`h-2 w-2 rounded-full ${active ? "bg-bull animate-pulse-glow" : "bg-destructive"}`} />
        <span className={active ? "text-bull" : "text-destructive"}>
          {active ? "Scanner Active" : "Scanner Offline"}
        </span>
      </div>

      <div className="flex items-center gap-1.5 text-muted-foreground z-10">
        <Clock className="h-3 w-3" />
        <span>Last scan: 2 min ago</span>
      </div>

      <div className="flex items-center gap-1.5 text-muted-foreground z-10">
        <Activity className="h-3 w-3" />
        <span>Next scan: 13 min</span>
      </div>

      <div className="flex items-center gap-1.5 z-10">
        <Zap className="h-3 w-3 text-bull" />
        <span className="text-bull">{activeSignals} active signals</span>
      </div>

      <div className="ml-auto font-mono text-muted-foreground z-10">
        {time.toLocaleTimeString("en-US", { hour12: false })}
      </div>
    </header>
  );
}
