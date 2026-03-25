import { useState, useMemo, useEffect } from "react";
import { useSignals } from "@/hooks/useSignals";
import { useTopSignals } from "@/hooks/useTopSignals";
import { useStreamingHealth } from "@/hooks/useStreamingHealth";
import { useFusionDecisions } from "@/hooks/useFusionDecisions";
import { useCatalysts } from "@/hooks/useCatalysts";
import { useBriefings } from "@/hooks/useBriefings";
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

function getCatalystSourceLabel(sourceType: string) {
  switch (sourceType) {
    case "finviz_news":
      return "FinViz news";
    case "finviz_insider":
      return "FinViz insider";
    case "finviz_volume":
      return "FinViz volume";
    case "technical_breakout":
      return "Technical";
    case "econ_surprise":
      return "Macro";
    case "congressional_trade":
      return "Congress";
    case "sec_insider":
      return "SEC";
    default:
      return sourceType.replace(/_/g, " ");
  }
}

function getCatalystSourceClass(sourceType: string) {
  switch (sourceType) {
    case "technical_breakout":
      return "border-bull/40 bg-bull/10 text-bull";
    case "econ_surprise":
      return "border-whale/40 bg-whale/10 text-whale";
    case "finviz_insider":
    case "congressional_trade":
    case "sec_insider":
      return "border-primary/40 bg-primary/10 text-primary";
    default:
      return "border-muted/40 bg-background/70 text-muted-foreground";
  }
}

function getDirectionClass(direction: string | null | undefined) {
  if (direction === "bull") return "border-bull/40 bg-bull/10 text-bull";
  if (direction === "bear") return "border-bear/40 bg-bear/10 text-bear";
  return "border-muted/40 bg-background/70 text-muted-foreground";
}

// ─── AI Top Trades expandable item ───────────────────────────────────────────

function TopTradeItem({ signal, rank }: { signal: Signal & { also_affects?: string[] }; rank: number }) {
  const [open, setOpen] = useState(false);
  const isBull = signal.suggested_action.toLowerCase().includes("bull");
  const dirColor = isBull ? "text-bull" : "text-bear";
  const directionLabel = isBull ? "BULL" : "BEAR";
  const tradeType = signal.proxy ? "proxy" : "direct";
  const deltaSign = signal.delta_pct > 0 ? "+" : "";
  const polyUrl = "https://polymarket.com/search?q=" + encodeURIComponent(signal.market_title.substring(0, 50));
  const detailTargetId = signal.proxy_source_signal_id || signal.id;
  const detailUrl = "/api/signals/" + detailTargetId + "/detail";
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
        <span className={`text-[10px] font-mono uppercase shrink-0 px-1.5 py-0.5 rounded border ${
          signal.proxy
            ? "border-whale/40 bg-whale/10 text-whale"
            : "border-muted/40 bg-background/60 text-muted-foreground"
        }`}>
          {tradeType}
        </span>
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
            {signal.proxy && (
              <span className="text-whale">Swedish catalyst proxy</span>
            )}
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

          {signal.proxy && signal.proxy_source_signal_id && (
            <p className="text-whale/80">
              Derived from a higher-confidence non-Swedish catalyst so Swedish Focus stays useful even when direct OMX titles are sparse.
            </p>
          )}

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
              {signal.proxy ? "Open source signal detail" : "Open signal detail"} <ExternalLink className="h-2.5 w-2.5" />
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
            {new Date(bull.timestamp).toLocaleString()} | {bull.matched_asset_name}
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
  const [swedishTradeFilter, setSwedishTradeFilter] = useState<"all" | "direct" | "proxy">("all");
  const { data: signals, isLoading } = useSignals({ hours, minConfidence: minConfidence || undefined, limit: 200 });
  const { data: topSignals, isLoading: topLoading, includeUnverified, setIncludeUnverified } = useTopSignals();
  const { data: swedishSignals, isLoading: sweLoading } = useSwedishSignals();
  const { data: briefings, isLoading: briefingsLoading } = useBriefings(10);
  const { data: streamingHealth, isLoading: streamingLoading } = useStreamingHealth();
  const { decisions: fusionDecisions, suppressed: fusionSuppressed, isLoading: fusionLoading } = useFusionDecisions();
  const { recent: recentCatalysts, diagnostics: catalystDiagnostics, isLoading: catalystLoading } = useCatalysts();

  const grouped = useMemo(() => groupContextPairs(signals), [signals]);
  const catalystConvergence = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of recentCatalysts) {
      const assetId = row.asset_ids?.[0];
      if (!assetId || !row.direction_hint || row.direction_hint === "neutral") continue;
      const key = `${assetId}:${row.direction_hint}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [recentCatalysts]);
  const filteredSwedishSignals = useMemo(() => {
    if (swedishTradeFilter === "direct") {
      return swedishSignals.filter(signal => !signal.proxy);
    }
    if (swedishTradeFilter === "proxy") {
      return swedishSignals.filter(signal => Boolean(signal.proxy));
    }
    return swedishSignals;
  }, [swedishSignals, swedishTradeFilter]);

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
          <span className="text-xs font-mono text-muted-foreground">Saab | SSAB | Boliden</span>
          <div className="flex items-center gap-1 ml-2">
            {(["all", "direct", "proxy"] as const).map(mode => (
              <Button
                key={mode}
                size="sm"
                variant={swedishTradeFilter === mode ? "default" : "outline"}
                className="h-6 text-[10px] px-2 font-mono uppercase"
                onClick={() => setSwedishTradeFilter(mode)}
              >
                {mode}
              </Button>
            ))}
          </div>
          <span className="text-xs font-mono text-muted-foreground ml-auto">
            {sweLoading ? "..." : `${filteredSwedishSignals.length} shown`}
          </span>
        </div>
        {sweLoading ? (
          <p className="text-xs text-muted-foreground font-mono">Loading...</p>
        ) : filteredSwedishSignals.length === 0 ? (
          <p className="text-xs text-muted-foreground font-mono">No Swedish signals yet.</p>
        ) : (
          <div className="space-y-1">
            {filteredSwedishSignals.map((signal, i) => (
              <TopTradeItem key={signal.id} signal={signal} rank={i + 1} />
            ))}
          </div>
        )}
      </div>

      {/* Morning Briefings */}
      <div className="rounded-lg border border-border bg-card/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Morning Briefings</h2>
          <span className="text-xs font-mono text-muted-foreground ml-auto">
            {briefingsLoading ? "..." : `${briefings.length} recent`}
          </span>
        </div>
        {briefingsLoading ? (
          <p className="text-xs text-muted-foreground font-mono">Loading briefing history...</p>
        ) : briefings.length === 0 ? (
          <p className="text-xs text-muted-foreground font-mono">No briefings generated yet.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {briefings.map(briefing => {
              const flag = briefing.market === "swedish" ? "[SE]" : "[US]";
              const marketLabel = briefing.market === "swedish" ? "OMX" : "US";
              const preview = briefing.briefing_text?.trim() || "No briefing text saved.";

              return (
                <a
                  key={`${briefing.market}-${briefing.date}`}
                  href={briefing.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded border border-border/60 bg-background/40 p-3 hover:border-bull/40 hover:bg-secondary/20 transition-colors space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{flag}</span>
                    <span className="text-xs font-mono uppercase">{marketLabel}</span>
                    <span className="text-xs font-mono text-muted-foreground ml-auto">{briefing.date}</span>
                  </div>
                  <p className="text-xs text-foreground leading-relaxed line-clamp-3">
                    {preview}
                  </p>
                  <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                    <span>{briefing.signal_count} signals | {briefing.top_assets.slice(0, 2).join(" | ") || "No top assets"}</span>
                    <span>{briefing.pushed_at ? "pushed" : "saved"}</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>

      {/* Streaming + fusion visibility */}
      <div className="rounded-lg border border-border bg-card/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Streaming Confirmation Layer</h2>
          <span className="text-xs font-mono text-muted-foreground ml-auto">
            {streamingLoading
              ? "..."
              : (streamingHealth?.enabled
                  ? "enabled"
                  : streamingHealth?.mode === "stale"
                    ? "stale"
                    : "disabled")}
          </span>
        </div>

        {!streamingHealth?.enabled ? (
          <p className="text-xs font-mono text-muted-foreground">
            {streamingHealth?.message || "Streaming layer disabled or unavailable (Phase 1 fallback active)."}
          </p>
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

      {/* Catalyst feed */}
      <div className="rounded-lg border border-border bg-card/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Catalyst Feed</h2>
          <span className="text-xs font-mono text-muted-foreground ml-auto">
            {catalystLoading ? "..." : `${recentCatalysts.length} recent / ${catalystDiagnostics.length} tracked`}
          </span>
        </div>
        {catalystLoading ? (
          <p className="text-xs font-mono text-muted-foreground">Loading catalyst diagnostics...</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded border border-border/60 bg-background/40 p-2">
              <p className="text-[11px] font-mono text-muted-foreground mb-1">Recent catalysts</p>
              <div className="space-y-1">
                {recentCatalysts.slice(0, 5).map((row) => (
                  <div key={row.id} className="rounded border border-border/50 bg-card/40 p-2 text-[11px] font-mono space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase ${getCatalystSourceClass(row.source_type)}`}>
                        {getCatalystSourceLabel(row.source_type)}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase ${getDirectionClass(row.direction_hint)}`}>
                        {row.direction_hint || "neutral"}
                      </span>
                      <span className="px-1.5 py-0.5 rounded border border-muted/40 bg-background/70 text-[10px] text-muted-foreground">
                        {Math.max(1, catalystConvergence.get(`${row.asset_ids?.[0]}:${row.direction_hint}`) || 0)}x aligned
                      </span>
                      <span className="ml-auto text-muted-foreground">
                        {(row.causal_strength * 100).toFixed(0)}
                      </span>
                    </div>
                    <div className="text-foreground truncate">{row.title}</div>
                    <div className="text-muted-foreground truncate">{row.normalized_summary || row.source_family}</div>
                  </div>
                ))}
                {recentCatalysts.length === 0 && (
                  <p className="text-[11px] font-mono text-muted-foreground">No recent catalysts yet.</p>
                )}
              </div>
            </div>
            <div className="rounded border border-border/60 bg-background/40 p-2">
              <p className="text-[11px] font-mono text-muted-foreground mb-1">Source-family edge</p>
              <div className="space-y-1">
                {catalystDiagnostics.slice(0, 5).map((row) => (
                  <div key={row.source_family} className="flex items-center justify-between gap-2 text-[11px] font-mono">
                    <span className="truncate">{row.source_family}</span>
                    <span>
                      {(row.reliability_score * 100).toFixed(0)} / {(row.hit_rate_30m * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
                {catalystDiagnostics.length === 0 && (
                  <p className="text-[11px] font-mono text-muted-foreground">Diagnostics will appear after backtest runs.</p>
                )}
              </div>
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

