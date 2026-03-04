import { useState } from "react";
import { Signal } from "@/types";
import { Anchor, ChevronDown, ChevronUp, ExternalLink, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface SignalCardProps {
  signal: Signal;
  /** Compact mode: condensed single-line summary (used in AI Top Trades list) */
  compact?: boolean;
  /** Nested mode: no outer rounded border (used inside grouped pairs) */
  nested?: boolean;
}

function deriveDirection(signal: Signal): "bull" | "bear" {
  return signal.suggested_action.toLowerCase().includes("bull") ? "bull" : "bear";
}

export function SignalCard({ signal, compact = false, nested = false }: SignalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const direction = deriveDirection(signal);
  const isBull = direction === "bull";
  const dirColor = isBull ? "text-bull" : "text-bear";
  const borderColor = isBull ? "border-l-bull" : "border-l-bear";
  const glowClass = signal.status === "new" && !compact && !nested ? (isBull ? "glow-bull" : "glow-bear") : "";
  const opacityClass = signal.status === "dismissed" || signal.status === "acted" ? "opacity-50" : "";

  const oddsBarWidth = Math.abs(signal.delta_pct) * 3;
  const primaryInstrument = signal.suggested_instruments?.[0];
  const timeWindow = `${signal.time_window_minutes}min`;

  // Compact layout: single row summary for AI top list
  if (compact) {
    return (
      <div className={`flex items-center gap-3 py-1 ${opacityClass}`}>
        <span className={`text-xs font-mono font-bold ${dirColor}`}>
          {signal.delta_pct > 0 ? "+" : ""}{signal.delta_pct.toFixed(1)}%
        </span>
        <span className="text-xs text-foreground truncate flex-1">{signal.matched_asset_name}</span>
        <span className="text-xs font-mono text-muted-foreground truncate hidden sm:block" style={{ maxWidth: "200px" }}>
          {signal.market_title.substring(0, 50)}
        </span>
        <span className="text-xs font-mono text-muted-foreground">{signal.confidence}%</span>
        {signal.whale_detected && <Anchor className="h-3 w-3 text-whale shrink-0" />}
      </div>
    );
  }

  const wrapClass = nested
    ? `bg-card border-l-2 ${borderColor} ${glowClass} ${opacityClass} transition-all`
    : `bg-card border border-border border-l-2 ${borderColor} rounded-lg ${glowClass} ${opacityClass} transition-all`;

  return (
    <div className={wrapClass}>
      <div
        className="flex items-center gap-4 p-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Left: Market + timestamp */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground truncate">{signal.market_title}</h3>
          <p className="text-xs font-mono text-muted-foreground mt-0.5">
            {new Date(signal.timestamp).toLocaleString()} · {timeWindow}
            {signal.matched_asset_name && (
              <span className="ml-2 text-muted-foreground/60">· {signal.matched_asset_name}</span>
            )}
          </p>
        </div>

        {/* Center: Odds bar + delta */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">{(signal.odds_before * 100).toFixed(0)}%</span>
            <div className="w-24 h-1.5 bg-secondary rounded-full relative overflow-hidden">
              <div
                className={`absolute top-0 left-0 h-full rounded-full ${isBull ? "bg-bull" : "bg-bear"}`}
                style={{ width: `${Math.min(oddsBarWidth, 100)}%` }}
              />
            </div>
            <span className="text-xs font-mono text-muted-foreground">{(signal.odds_now * 100).toFixed(0)}%</span>
          </div>
          <span className={`text-xl font-mono font-bold ${dirColor}`}>
            {signal.delta_pct > 0 ? "+" : ""}
            {signal.delta_pct.toFixed(1)}%
          </span>
        </div>

        {/* Right: Action + confidence + indicators */}
        <div className="flex items-center gap-3 shrink-0">
          {primaryInstrument && (
            <Badge
              variant="outline"
              className={`font-mono text-xs ${isBull ? "border-bull/30 text-bull" : "border-bear/30 text-bear"}`}
            >
              {primaryInstrument.name}
            </Badge>
          )}

          {/* Judgment required indicator */}
          {signal.requires_judgment && (
            <Tooltip>
              <TooltipTrigger>
                <AlertTriangle className="h-4 w-4 text-whale" />
              </TooltipTrigger>
              <TooltipContent className="bg-card border-border">
                <span className="font-mono text-whale text-xs">Human judgment required</span>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Confidence */}
          <div className="flex items-center gap-1.5">
            <div className="w-12 h-1.5 bg-secondary rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${signal.confidence >= 70 ? "bg-bull" : signal.confidence >= 50 ? "bg-whale" : "bg-bear"}`}
                style={{ width: `${signal.confidence}%` }}
              />
            </div>
            <span className="text-xs font-mono text-muted-foreground">{signal.confidence}%</span>
          </div>

          {/* Whale */}
          {signal.whale_detected && (
            <Tooltip>
              <TooltipTrigger>
                <Anchor className="h-4 w-4 text-whale" />
              </TooltipTrigger>
              <TooltipContent className="bg-card border-border">
                <span className="font-mono text-whale">${(signal.whale_amount_usd ?? 0).toLocaleString()}</span>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Status badge */}
          <Badge
            variant="outline"
            className={`text-[10px] uppercase tracking-wider ${
              signal.status === "new"
                ? "border-bull/30 text-bull"
                : signal.status === "viewed"
                  ? "border-muted-foreground/30 text-muted-foreground"
                  : "border-muted-foreground/20 text-muted-foreground/50"
            }`}
          >
            {signal.status}
          </Badge>

          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
          <p className="text-sm text-secondary-foreground leading-relaxed">{signal.reasoning}</p>

          {/* Suggested instruments */}
          {signal.suggested_instruments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {signal.suggested_instruments.map((inst, i) => (
                <div key={i} className="flex items-center gap-2">
                  {inst.avanza_url ? (
                    <Button variant="outline" size="sm" className="text-xs font-mono border-border" asChild>
                      <a href={inst.avanza_url} target="_blank" rel="noopener noreferrer">
                        {inst.name} <ExternalLink className="ml-1.5 h-3 w-3" />
                      </a>
                    </Button>
                  ) : (
                    <Badge variant="outline" className="font-mono text-xs border-muted-foreground/30">
                      {inst.name}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}

          <span className="text-xs font-mono text-muted-foreground">ID: {signal.id}</span>
        </div>
      )}
    </div>
  );
}
