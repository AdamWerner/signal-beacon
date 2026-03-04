import { useState } from "react";
import { useWhales } from "@/hooks/useWhales";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

const WhaleTracker = () => {
  const { data: whales } = useWhales();
  const [marketFilter, setMarketFilter] = useState("");
  const [minAmount, setMinAmount] = useState("");

  const filtered = whales.filter((w) => {
    if (marketFilter && !w.market.toLowerCase().includes(marketFilter.toLowerCase())) return false;
    if (minAmount && w.amount < Number(minAmount)) return false;
    return true;
  });

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">Whale Tracker</h1>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <Input
          placeholder="Filter by market..."
          value={marketFilter}
          onChange={(e) => setMarketFilter(e.target.value)}
          className="bg-secondary border-border text-sm max-w-xs"
        />
        <Input
          placeholder="Min amount ($)"
          type="number"
          value={minAmount}
          onChange={(e) => setMinAmount(e.target.value)}
          className="bg-secondary border-border text-sm font-mono max-w-[160px]"
        />
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-[180px_2fr_140px_80px_80px] gap-2 px-4 py-2 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <span>Timestamp</span>
          <span>Market</span>
          <span>Amount</span>
          <span>Direction</span>
          <span>Odds YES</span>
        </div>
        {filtered.map((w) => (
          <div key={w.id} className="grid grid-cols-[180px_2fr_140px_80px_80px] gap-2 px-4 py-3 border-t border-border hover:bg-secondary/10 items-center transition-colors">
            <span className="text-xs font-mono text-muted-foreground">
              {new Date(w.timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="text-sm truncate">{w.market}</span>
            <span className="text-sm font-mono font-bold text-whale">${w.amount.toLocaleString()}</span>
            <Badge
              variant="outline"
              className={`text-[10px] w-fit ${w.direction === "YES" ? "border-bull/30 text-bull" : "border-bear/30 text-bear"}`}
            >
              {w.direction}
            </Badge>
            <span className="text-xs font-mono text-muted-foreground">
              {w.price_at_trade != null ? `${(w.price_at_trade * 100).toFixed(0)}%` : '—'}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No whale entries match filters.</div>
        )}
      </div>
    </div>
  );
};

export default WhaleTracker;
