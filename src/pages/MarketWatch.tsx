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

function MarketDetail({ market }: { market: MarketWatchType }) {
  return (
    <div className="p-4 border-t border-border bg-secondary/20">
      <h3 className="text-sm font-medium mb-3">{market.market} — 7 Day Odds History</h3>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={market.history}>
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: "hsl(220 5% 45%)" }}
              tickFormatter={(t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              stroke="hsl(245 15% 16%)"
              interval={23}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "hsl(220 5% 45%)" }}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              stroke="hsl(245 15% 16%)"
              domain={["auto", "auto"]}
            />
            <Tooltip
              contentStyle={{ background: "hsl(240 15% 8%)", border: "1px solid hsl(245 15% 16%)", borderRadius: 6, fontSize: 12 }}
              labelFormatter={(t) => new Date(t).toLocaleString()}
              formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, "Odds"]}
            />
            <Line type="monotone" dataKey="odds" stroke="hsl(155 100% 50%)" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const MarketWatchPage = () => {
  const { data: markets } = useMarkets();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">Market Watch</h1>
      <div className="border border-border rounded-lg overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[2fr_1fr_1fr_1fr_80px_80px] gap-2 px-4 py-2 bg-secondary/30 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <span>Market</span>
          <span>Current Odds</span>
          <span>24h Change</span>
          <span>Last Delta</span>
          <span>Whale</span>
          <span>Status</span>
        </div>
        {markets.map((m) => (
          <div key={m.id}>
            <div
              className="grid grid-cols-[2fr_1fr_1fr_1fr_80px_80px] gap-2 px-4 py-3 border-t border-border hover:bg-secondary/10 cursor-pointer items-center transition-colors"
              onClick={() => setExpandedId(expandedId === m.id ? null : m.id)}
            >
              <span className="text-sm font-medium truncate">{m.market}</span>
              <div className="flex items-center gap-2">
                <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-bull rounded-full" style={{ width: `${m.current_odds * 100}%` }} />
                </div>
                <span className="text-sm font-mono">{(m.current_odds * 100).toFixed(0)}%</span>
              </div>
              <MiniSparkline data={m.sparkline} color={m.change_24h >= 0 ? "hsl(155,100%,50%)" : "hsl(345,100%,60%)"} />
              <span className={`text-sm font-mono font-bold ${m.last_delta >= 0 ? "text-bull" : "text-bear"}`}>
                {m.last_delta > 0 ? "+" : ""}{m.last_delta}%
              </span>
              <span>{m.whale_alert && <span className="h-2 w-2 rounded-full bg-whale inline-block" />}</span>
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
