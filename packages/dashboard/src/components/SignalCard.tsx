import { useState } from "react";
import { Signal } from "@/types";
import { Anchor, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface SignalCardProps {
  signal: Signal;
}

export function SignalCard({ signal }: SignalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isBull = signal.direction === "bull";
  const dirColor = isBull ? "text-bull" : "text-bear";
  const borderColor = isBull ? "border-l-bull" : "border-l-bear";
  const glowClass = signal.status === "new" ? (isBull ? "glow-bull" : "glow-bear") : "";
  const opacityClass = signal.status === "expired" ? "opacity-50" : "";

  const oddsBarWidth = Math.abs(signal.delta_pct) * 3;

  return (
    <div
      className={`bg-card border border-border border-l-2 ${borderColor} rounded-lg ${glowClass} ${opacityClass} transition-all`}
    >
      <div
        className="flex items-center gap-4 p-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Left: Market + timestamp */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-foreground truncate">{signal.market_title}</h3>
          <p className="text-xs font-mono text-muted-foreground mt-0.5">
            {new Date(signal.timestamp).toLocaleString()} · {signal.time_window}
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
            {signal.delta_pct}%
          </span>
        </div>

        {/* Right: Action + confidence + whale */}
        <div className="flex items-center gap-3 shrink-0">
          <Badge
            variant="outline"
            className={`font-mono text-xs ${isBull ? "border-bull/30 text-bull" : "border-bear/30 text-bear"}`}
          >
            {signal.instrument}
          </Badge>

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
                <span className="font-mono text-whale">${signal.whale_amount.toLocaleString()}</span>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Status badge */}
          <Badge
            variant="outline"
            className={`text-[10px] uppercase tracking-wider ${
              signal.status === "new"
                ? "border-bull/30 text-bull"
                : signal.status === "reviewed"
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
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" className="text-xs font-mono border-border" asChild>
              <a href={signal.avanza_url} target="_blank" rel="noopener noreferrer">
                Open on Avanza <ExternalLink className="ml-1.5 h-3 w-3" />
              </a>
            </Button>
            <span className="text-xs font-mono text-muted-foreground">ID: {signal.id}</span>
          </div>
        </div>
      )}
    </div>
  );
}
