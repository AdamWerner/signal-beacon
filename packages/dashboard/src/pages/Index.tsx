import { useState, useMemo, useEffect } from "react";
import { useSignals } from "@/hooks/useSignals";
import { useTopSignals } from "@/hooks/useTopSignals";
import { useStreamingHealth } from "@/hooks/useStreamingHealth";
import { useFusionDecisions } from "@/hooks/useFusionDecisions";
import { SignalCard } from "@/components/SignalCard";
import { Signal } from "@/types";
import { Zap, Trophy, SlidersHorizontal, Flag, ExternalLink, ChevronDown, ChevronUp, Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ─── Swedish Focus hook ───────────────────────────────────────────────────────

function useSwedishSignals() {
  const [data, setData] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/signals/top/swedish');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData(await res.json());
      } catch { /* silent */ } finally { setIsLoading(false); }
    };
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  return { data, isLoading };
}

// ─── AI Top Trades expandable item ───────────────────────────────────────────

function TopTradeItem({ signal, rank }: { signal: Signal & { also_affects?: string[] }; rank: number }) {
  const [open, setOpen] = useState(false);
  const isBull = signal.suggested_action.toLowerCase().includes("bull");
  const dirColor = isBull ? "text-bull" : "text-bear";
  const directionLabel = isBull ? "BULL" : "BEAR";
  const deltaSign = signal.delta_pct > 0 ? "+" : "";
  const polyUrl = "https://polymarket.com/search?q=" + encodeURIComponent(signal.market_title.substring(0, 50));
  const detailUrl = "/api/signals/" + signal.id + "/detail";
  const instrument = signal.suggested_instruments?.[0];
  const verificationStatus = signal.verification_status || "pending";
  const verificationSource = signal.verification_source || "none";
  const verificationReason = signal.verification_reason || "No verification decision";

  const verificationClass =
    verificationStatus === "approved"
      ? "text-bull border-bull/40 bg-bull/10"
      : verificationStatus === "rejected"
        ? "text-bear border-bear/40 bg-bear/10"
        : "text-whale border-whale/40 bg-whale/10";

  const cardClass = rank === 1 ? "rounded border border-bull/40 bg-bull/5 overflow-hidden" : "rounded border border-border/50 bg-card/30 overflow-hidden";
  const directionClass = isBull ? "text-bull border-bull/40" : "text-bear border-bear/40";

  return (
    <div className={cardClass}>
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-secondary/20 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-xs font-mono font-bold text-muted-foreground w-4">#{rank}</span>
        <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${directionClass}`}>
          {directionLabel}
        </span>
        <span className="text-sm font-semibold flex-1 truncate">{signal.matched_asset_name}</span>
        <span className="text-xs font-mono text-muted-foreground hidden sm:block truncate max-w-[200px]">
          {signal.market_title.substring(0, 55)}
        </span>
        <span className={`text-xs font-mono font-bold ${dirColor} shrink-0`}>
          {deltaSign}{signal.delta_pct?.toFixed(1)}%
        </span>
        <span className="text-xs font-mono text-foreground shrink-0">{signal.confidence}%</span>
        <span className={`text-[10px] font-mono uppercase shrink-0 px-1.5 py-0.5 rounded border ${verificationClass}`}>
          {verificationStatus.replace("_", " ")}
        </span>
        {open ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />}
      </div>

      {open && (
        <div className="px-3 pb-3 pt-2 border-t border-border/50 bg-secondary/10 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Setup:</span>
            <span className={`font-mono font-bold ${dirColor}`}>{directionLabel}</span>
            <span className="font-mono">{signal.matched_asset_name}</span>
            {instrument?.name && (
              <span className="text-muted-foreground">via {instrument.name}</span>
            )}
          </div>

          <p className="text-foreground leading-relaxed">{signal.market_title}</p>

          <div className="rounded border border-border/50 bg-background/40 px-2 py-1.5">
            <span className="text-muted-foreground">Why approved:</span>{" "}
            <span className="text-foreground">{verificationReason}</span>
            <span className="text-muted-foreground"> ({verificationSource})</span>
          </div>

          <p className="font-mono text-muted-foreground">
            Odds: {(signal.odds_before * 100).toFixed(0)}% -&gt; {(signal.odds_now * 100).toFixed(0)}%{" "}
            ({deltaSign}{signal.delta_pct?.toFixed(1)}%)
          </p>

          {instrument && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Instrument:</span>
              {instrument.avanza_url ? (
                <a href={instrument.avanza_url} target="_blank" rel="noopener noreferrer"
                  className="text-bull hover:underline flex items-center gap-1">
                  {instrument.name} <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ) : (
                <span className="font-mono">{instrument.name}</span>
              )}
            </div>
          )}

          {signal.also_affects && signal.also_affects.length > 0 && (
            <p className="text-muted-foreground/70">
              Also affects: {signal.also_affects.join(', ')}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <a href={detailUrl} target="_blank" rel="noopener noreferrer"
              className="text-bull hover:underline flex items-center gap-1">
              Open signal detail <ExternalLink className="h-2.5 w-2.5" />
            </a>
            <a href={polyUrl} target="_blank" rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1">
              Open on Polymarket <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// Context-dependent single card
function ContextCard({ bull, bear }: { bull: Signal; bear: Signal }) {
  const [open, setOpen] = useState(false);
  const polyUrl = `https://polymarket.com/search?q=${encodeURIComponent(bull.market_title.substring(0, 50))}`;
  const deltaSign = bull.delta_pct > 0 ? "+" : "";

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-4 p-4 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground truncate">{bull.market_title}</h3>
          <p className="text-xs font-mono text-muted-foreground mt-0.5">
            {new Date(bull.timestamp).toLocaleString()} · {bull.matched_asset_name}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Badge variant="outline" className="text-[10px] uppercase border-whale/30 text-whale">⚖ Context</Badge>
          <span className="text-xs font-mono font-bold text-foreground">
            {deltaSign}{bull.delta_pct?.toFixed(1)}%
          </span>
          <span className="text-xs font-mono text-muted-foreground">
            {Math.max(bull.confidence, bear.confidence)}%
          </span>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <div className="px-4 pb-4 border-t border-border pt-3 space-y-3 text-xs">
          <p className="text-sm text-secondary-foreground">{bull.reasoning}</p>
          <div className="flex gap-4">
            <div>
              <span className="font-mono text-bull font-bold">BULL</span>
              <span className="ml-2 text-muted-foreground">{bull.suggested_instruments?.[0]?.name ?? '—'}</span>
            </div>
            <div>
              <span className="font-mono text-bear font-bold">BEAR</span>
              <span className="ml-2 text-muted-foreground">{bear.suggested_instruments?.[0]?.name ?? '—'}</span>
            </div>
          </div>
          <p className="font-mono text-muted-foreground">
            Odds: {(bull.odds_before * 100).toFixed(0)}% → {(bull.odds_now * 100).toFixed(0)}%
          </p>
          {polyUrl && (
            <a href={polyUrl} target="_blank" rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1">
              Open on Polymarket search <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Group context_dependent BULL+BEAR pairs ─────────────────────────────────

function groupContextPairs(signals: Signal[]): Array<Signal | [Signal, Signal]> {
  const pairs = new Map<string, Signal[]>();
  const order: string[] = [];

  for (const s of signals) {
    if (s.polarity === "context_dependent" && Boolean(s.requires_judgment)) {
      const key = `${s.market_condition_id}__${s.matched_asset_id}`;
      if (!pairs.has(key)) {
        pairs.set(key, []);
        order.push(`cd:${key}`);
      }
      pairs.get(key)!.push(s);
    } else {
      order.push(`s:${s.id}`);
    }
  }

  const result: Array<Signal | [Signal, Signal]> = [];
  const seenPairs = new Set<string>();
  const byId = new Map(signals.map(s => [s.id, s]));

  for (const key of order) {
    if (key.startsWith("s:")) {
      const s = byId.get(key.slice(2));
      if (s) result.push(s);
    } else {
      const pairKey = key.slice(3);
      if (!seenPairs.has(pairKey)) {
        seenPairs.add(pairKey);
        const group = pairs.get(pairKey)!;
        if (group.length >= 2) {
          result.push([group[0], group[1]] as [Signal, Signal]);
        } else {
          result.push(group[0]);
        }
      }
    }
  }

  return result;
}

// ─── Filter options ───────────────────────────────────────────────────────────

const TIME_OPTIONS = [
  { label: "1h", hours: 1 },
  { label: "4h", hours: 4 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "All", hours: undefined },
];

const CONF_OPTIONS = [
  { label: "Any", value: 0 },
  { label: "40%+", value: 40 },
  { label: "50%+", value: 50 },
  { label: "65%+", value: 65 },
];

// ─── Main page ────────────────────────────────────────────────────────────────

const SignalFeed = () => {
  const [hours, setHours] = useState<number | undefined>(24);
  const [minConfidence, setMinConfidence] = useState(0);
  const { data: signals, isLoading } = useSignals({ hours, minConfidence: minConfidence || undefined, limit: 200 });
  const { data: topSignals, isLoading: topLoading, includeUnverified, setIncludeUnverified } = useTopSignals();
  const { data: swedishSignals, isLoading: sweLoading } = useSwedishSignals();
  const { data: streamingHealth, isLoading: streamingLoading } = useStreamingHealth();
  const { decisions: fusionDecisions, suppressed: fusionSuppressed, isLoading: fusionLoading } = useFusionDecisions();

  const grouped = useMemo(() => groupContextPairs(signals), [signals]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">

      {/* AI Top Trades */}
      <div className="rounded-lg border border-bull/20 bg-bull/5 p-4 space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <Trophy className="h-4 w-4 text-bull" />
          <h2 className="text-sm font-semibold text-bull">AI Top Trades - Execution Desk</h2>
          <Button
            size="sm"
            variant={includeUnverified ? "outline" : "default"}
            className="h-6 text-[10px] px-2 font-mono"
            onClick={() => setIncludeUnverified(v => !v)}
          >
            {includeUnverified ? "Show verified only" : "Include unverified (debug)"}
          </Button>
          <span className="text-xs font-mono text-muted-foreground ml-auto">
            {topLoading ? "Ranking..." : `${topSignals.length} highest-conviction ${includeUnverified ? "(debug view)" : "(verified only)"}`}
          </span>
        </div>
        {topLoading ? (
          <p className="text-xs text-muted-foreground font-mono">Asking Claude to rank signals...</p>
        ) : topSignals.length === 0 ? (
          <p className="text-xs text-muted-foreground font-mono">No ranked signals yet — run a scan to generate data.</p>
        ) : (
          <div className="space-y-1">
            {topSignals.map((signal, i) => (
              <TopTradeItem key={signal.id} signal={signal} rank={i + 1} />
            ))}
          </div>
        )}
      </div>

      {/* Swedish Focus */}
      <div className="rounded-lg border border-border bg-card/50 p-4 space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <Flag className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Swedish Focus</h2>
          <span className="text-xs font-mono text-muted-foreground">Saab · SSAB · Boliden</span>
          <span className="text-xs font-mono text-muted-foreground ml-auto">
            {sweLoading ? "..." : `${swedishSignals.length} signals`}
          </span>
        </div>
        {sweLoading ? (
          <p className="text-xs text-muted-foreground font-mono">Loading...</p>
        ) : swedishSignals.length === 0 ? (
          <p className="text-xs text-muted-foreground font-mono">No Swedish signals yet.</p>
        ) : (
          <div className="space-y-1">
            {swedishSignals.map((signal, i) => (
              <TopTradeItem key={signal.id} signal={signal} rank={i + 1} />
            ))}
          </div>
        )}
      </div>

      {/* Streaming + fusion visibility */}
      <div className="rounded-lg border border-border bg-card/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Streaming Confirmation Layer</h2>
          <span className="text-xs font-mono text-muted-foreground ml-auto">
            {streamingLoading ? "..." : (streamingHealth?.enabled ? "enabled" : "disabled")}
          </span>
        </div>

        {!streamingHealth?.enabled ? (
          <p className="text-xs font-mono text-muted-foreground">Streaming layer disabled or unavailable (Phase 1 fallback active).</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded border border-border/60 bg-background/40 p-2">
              <p className="text-[11px] font-mono text-muted-foreground mb-1">Health</p>
              <div className="space-y-1">
                {(streamingHealth.runtime || []).map((row: any) => (
                  <div key={row.component} className="flex items-center justify-between text-[11px] font-mono">
                    <span>{row.component}</span>
                    <span className={row.status === "healthy" ? "text-bull" : row.status === "down" ? "text-bear" : "text-whale"}>
                      {row.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded border border-border/60 bg-background/40 p-2">
              <p className="text-[11px] font-mono text-muted-foreground mb-1">Fusion Decisions (latest)</p>
              {fusionLoading ? (
                <p className="text-[11px] font-mono text-muted-foreground">Loading...</p>
              ) : (
                <div className="space-y-1">
                  {fusionDecisions.slice(0, 4).map((row: any, idx: number) => (
                    <div key={`${row.timestamp}-${idx}`} className="text-[11px] font-mono flex items-center justify-between gap-2">
                      <span className="truncate">{row.symbol} {row.decision}</span>
                      <span>{Number(row.p_hat || 0).toFixed(2)} / {Number(row.expectancy_hat_pct || 0).toFixed(2)}%</span>
                    </div>
                  ))}
                  <div className="text-[11px] font-mono text-muted-foreground">
                    Suppressed (latest): {fusionSuppressed.length}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Filters + header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-mono text-muted-foreground">Filters:</span>
        </div>

        <div className="flex items-center gap-1">
          {TIME_OPTIONS.map(opt => (
            <Button
              key={opt.label}
              size="sm"
              variant={hours === opt.hours ? "default" : "outline"}
              className="h-6 text-xs px-2 font-mono"
              onClick={() => setHours(opt.hours)}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {CONF_OPTIONS.map(opt => (
            <Button
              key={opt.label}
              size="sm"
              variant={minConfidence === opt.value ? "default" : "outline"}
              className="h-6 text-xs px-2 font-mono"
              onClick={() => setMinConfidence(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-mono text-muted-foreground">{signals.length} signals</span>
        </div>
      </div>

      {/* Signal feed */}
      {isLoading ? (
        <p className="text-xs text-muted-foreground font-mono">Loading signals...</p>
      ) : signals.length === 0 ? (
        <p className="text-xs text-muted-foreground font-mono">No signals match the current filters.</p>
      ) : (
        <div className="space-y-3">
          {grouped.map((item) => {
            if (Array.isArray(item)) {
              const [a, b] = item;
              const bull = a.suggested_action.toLowerCase().includes("bull") ? a : b;
              const bear = a.suggested_action.toLowerCase().includes("bull") ? b : a;
              return <ContextCard key={`ctx-${bull.id}`} bull={bull} bear={bear} />;
            }
            return <SignalCard key={item.id} signal={item} />;
          })}
        </div>
      )}
    </div>
  );
};

export default SignalFeed;
