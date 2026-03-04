import { useState } from "react";
import { useCorrelations, CorrelationMarket } from "@/hooks/useCorrelations";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, ExternalLink, Zap } from "lucide-react";

const CATEGORY_LABEL: Record<string, string> = {
  defense: "🛡 Defense",
  energy: "⛽ Energy",
  technology: "💻 Technology",
  tech: "💻 Technology",
  ev: "⚡ EV / Auto",
  transport: "🚚 Transport",
  mining: "⛏ Mining",
  steel: "🏭 Steel",
  pharma: "💊 Pharma",
  shipping: "🚢 Shipping",
  telecom: "📡 Telecom",
  renewables: "🌿 Renewables",
  nuclear: "☢ Nuclear",
  crypto: "🪙 Crypto",
  gaming: "🎲 Gaming",
  retail: "🛍 Retail",
  automotive: "🚗 Automotive",
  finance: "📈 Finance",
  index: "📊 Index",
  media: "🎵 Media",
  other: "📌 Other",
};

function polarityBadge(polarity: string) {
  if (polarity === "direct") return <Badge variant="outline" className="text-[10px] border-bull/30 text-bull">DIRECT</Badge>;
  if (polarity === "inverse") return <Badge variant="outline" className="text-[10px] border-bear/30 text-bear">INVERSE</Badge>;
  return <Badge variant="outline" className="text-[10px] border-whale/30 text-whale">CONTEXT</Badge>;
}

function MarketRow({ market }: { market: CorrelationMarket }) {
  const [open, setOpen] = useState(false);
  const hasSignals = market.mappings.some(m => m.signal_count_48h > 0);
  const totalSignals = market.mappings.reduce((s, m) => s + m.signal_count_48h, 0);
  const polyUrl = `https://polymarket.com/event/${market.market_slug}`;
  const oddsDisplay = market.current_odds != null
    ? `${(market.current_odds * 100).toFixed(0)}% YES`
    : '—';

  return (
    <div className={`rounded border ${hasSignals ? 'border-bull/20' : 'border-border/40'} overflow-hidden`}>
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-secondary/20 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-sm flex-1 truncate">{market.market_title}</span>
        <span className="text-xs font-mono text-muted-foreground shrink-0">{oddsDisplay}</span>
        {hasSignals && (
          <span className="flex items-center gap-1 text-xs font-mono text-bull shrink-0">
            <Zap className="h-3 w-3" />{totalSignals}
          </span>
        )}
        <span className="text-xs font-mono text-muted-foreground shrink-0">
          {market.mappings.length} asset{market.mappings.length !== 1 ? 's' : ''}
        </span>
        {open ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />}
      </div>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-border/40 bg-secondary/10 space-y-2">
          <a href={polyUrl} target="_blank" rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
            polymarket.com/event/{market.market_slug} <ExternalLink className="h-2.5 w-2.5" />
          </a>
          {market.mappings.map(m => (
            <div key={m.asset_id} className="flex items-start gap-3 text-xs">
              <span className="font-medium w-32 shrink-0">{m.asset_name}</span>
              {polarityBadge(m.polarity)}
              {m.signal_count_48h > 0 && (
                <span className="text-bull font-mono">{m.signal_count_48h} signal{m.signal_count_48h !== 1 ? 's' : ''} · {m.avg_confidence}% avg</span>
              )}
              {m.best_signal_id && (
                <a href={`/api/signals/${m.best_signal_id}/detail`} target="_blank" rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground flex items-center gap-0.5">
                  detail <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CorrelationsPage = () => {
  const { data, isLoading } = useCorrelations();
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set(['defense', 'energy', 'technology']));

  if (isLoading) {
    return <div className="text-xs text-muted-foreground font-mono p-4">Loading correlations...</div>;
  }

  if (!data) {
    return <div className="text-xs text-muted-foreground font-mono p-4">No data available.</div>;
  }

  const categories = Object.entries(data.categories)
    .sort(([a], [b]) => a.localeCompare(b));

  const toggle = (cat: string) => {
    setExpandedCats(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">Correlation Map</h1>
        <span className="text-xs font-mono text-muted-foreground">
          {data.total_markets} markets · {data.total_with_signals} with signals
        </span>
      </div>

      {categories.map(([cat, markets]) => {
        const open = expandedCats.has(cat);
        const marketsWithSignals = markets.filter(m => m.mappings.some(mp => mp.signal_count_48h > 0));
        const totalSignals = markets.reduce((s, m) => s + m.mappings.reduce((ss, mp) => ss + mp.signal_count_48h, 0), 0);

        return (
          <div key={cat} className="rounded-lg border border-border overflow-hidden">
            <div
              className="flex items-center gap-3 px-4 py-3 bg-card cursor-pointer hover:bg-secondary/20 transition-colors"
              onClick={() => toggle(cat)}
            >
              <span className="text-sm font-semibold flex-1">
                {CATEGORY_LABEL[cat] ?? cat}
              </span>
              <span className="text-xs font-mono text-muted-foreground">{markets.length} markets</span>
              {totalSignals > 0 && (
                <span className="flex items-center gap-1 text-xs font-mono text-bull">
                  <Zap className="h-3 w-3" />{totalSignals} signals · {marketsWithSignals.length} active
                </span>
              )}
              {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </div>

            {open && (
              <div className="p-3 space-y-1.5 bg-background/50">
                {markets.map(m => (
                  <MarketRow key={m.market_condition_id} market={m} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CorrelationsPage;
