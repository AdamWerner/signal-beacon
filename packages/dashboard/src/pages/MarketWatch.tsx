import { useState } from "react";
import { useMarkets } from "@/hooks/useMarkets";
import { MarketWatch as MarketWatchType } from "@/types";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <div className="w-20 h-6">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <Line type="monotone" dataKey="v" stroke={color} dot={false} strokeWidth={1.5} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function MarketDetail({ market }: { market: MarketWatchType & { mapped_assets?: string[] } }) {
  return (
    <div className="p-4 border-t border-border bg-secondary/20 space-y-3">
      {market.mapped_assets && market.mapped_assets.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">Mapped Assets</p>
          <div className="flex flex-wrap gap-1">
            {market.mapped_assets.map((a: string) => (
              <span key={a} className="text-xs bg-secondary px-2 py-0.5 rounded font-mono">{a}</span>
            ))}
          </div>
        </div>
      )}
      {market.sparkline.length > 1 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">4h Odds Trend</p>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={market.history}>
                <YAxis
                  tick={{ fontSize: 10, fill: "hsl(220 5% 45%)" }}
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                  stroke="hsl(245 15% 16%)"
                  domain={["auto", "auto"]}
                  width={36}
                />
                <Tooltip
                  contentStyle={{ background: "hsl(240 15% 8%)", border: "1px solid hsl(245 15% 16%)", borderRadius: 6, fontSize: 12 }}
                  formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, "Odds YES"]}
                />
                <Line type="monotone" dataKey="odds" stroke="hsl(155 100% 50%)" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

const MarketWatchPage = () => {
  const { data: markets, isLoading } = useMarkets();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-semibold">Market Watch</h1>
        <span className="text-xs font-mono text-muted-foreground">— top 20 by recent delta</span>
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[2fr_100px_80px_120px_80px_80px] gap-2 px-4 py-2 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <span>Market</span>
          <span>Odds NOW</span>
          <span>Last Δ</span>
          <span>4h Trend</span>
          <span>24h Δ</span>
          <span>Status</span>
        </div>
        {isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading trending markets...</div>
        ) : markets.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No market data — run a scan first.</div>
        ) : markets.map((m) => (
          <div key={m.id}>
            <div
              className="grid grid-cols-[2fr_100px_80px_120px_80px_80px] gap-2 px-4 py-3 border-t border-border hover:bg-secondary/10 cursor-pointer items-center transition-colors"
              onClick={() => setExpandedId(expandedId === m.id ? null : m.id)}
            >
              <span className="text-sm font-medium truncate">{m.market}</span>
              <div className="flex items-center gap-2">
                <div className="w-10 h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-bull rounded-full" style={{ width: `${m.current_odds * 100}%` }} />
                </div>
                <span className="text-xs font-mono">{(m.current_odds * 100).toFixed(0)}%</span>
              </div>
              <span className={`text-sm font-mono font-bold ${m.last_delta >= 0 ? "text-bull" : "text-bear"}`}>
                {m.last_delta > 0 ? "+" : ""}{typeof m.last_delta === 'number' ? m.last_delta.toFixed(1) : m.last_delta}%
              </span>
              {m.sparkline.length > 0 ? (
                <MiniSparkline data={m.sparkline} color={m.change_24h >= 0 ? "hsl(155,100%,50%)" : "hsl(345,100%,60%)"} />
              ) : (
                <span className="text-xs text-muted-foreground font-mono">—</span>
              )}
              <span className={`text-xs font-mono ${m.change_24h >= 0 ? "text-bull" : "text-bear"}`}>
                {m.change_24h > 0 ? "+" : ""}{typeof m.change_24h === 'number' ? m.change_24h.toFixed(1) : '0'}%
              </span>
              <Badge
                variant="outline"
                className={`text-[10px] uppercase tracking-wider w-fit ${
                  m.status === "alert" ? "border-bear/30 text-bear" : m.status === "active" ? "border-bull/30 text-bull" : "border-muted-foreground/30 text-muted-foreground"
                }`}
              >
                {m.status}
              </Badge>
            </div>
            {expandedId === m.id && <MarketDetail market={m} />}
          </div>
        ))}
      </div>
    </div>
  );
};

export default MarketWatchPage;
