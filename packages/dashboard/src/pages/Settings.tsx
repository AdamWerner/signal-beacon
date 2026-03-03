import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";

const defaultWatchlist = [
  "fed-rate-hike-june-2026",
  "trump-china-tariffs-april",
  "opec-production-cut-q2",
  "eu-ai-regulation-summer",
  "russia-ukraine-ceasefire-may",
  "bitcoin-etf-approval-eu",
  "us-recession-2026",
  "oil-above-100-q3",
];

const SettingsPage = () => {
  const [watchlist, setWatchlist] = useState(defaultWatchlist);
  const [newSlug, setNewSlug] = useState("");

  const addSlug = () => {
    if (newSlug.trim() && !watchlist.includes(newSlug.trim())) {
      setWatchlist([...watchlist, newSlug.trim()]);
      setNewSlug("");
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-xl font-semibold">Settings</h1>

      {/* Scanner Thresholds */}
      <section className="bg-card border border-border rounded-lg p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Scanner Thresholds</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground">Odds Change Threshold (%)</Label>
            <Input type="number" defaultValue={8} className="mt-1 bg-secondary border-border font-mono" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Time Window (min)</Label>
            <Input type="number" defaultValue={60} className="mt-1 bg-secondary border-border font-mono" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Whale Threshold ($)</Label>
            <Input type="number" defaultValue={25000} className="mt-1 bg-secondary border-border font-mono" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Scan Interval</Label>
            <select className="mt-1 w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm font-mono text-foreground">
              <option>5 min</option>
              <option>10 min</option>
              <option selected>15 min</option>
              <option>30 min</option>
            </select>
          </div>
        </div>
      </section>

      {/* Alert Channels */}
      <section className="bg-card border border-border rounded-lg p-5 space-y-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Alert Channels</h2>

        {/* Pushover */}
        <div className="space-y-2 border-b border-border pb-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Pushover</span>
            <Switch defaultChecked />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">User Key</Label>
              <Input placeholder="User key" className="mt-1 bg-secondary border-border font-mono text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">App Token</Label>
              <Input placeholder="App token" className="mt-1 bg-secondary border-border font-mono text-sm" />
            </div>
          </div>
          <Button variant="outline" size="sm" className="text-xs border-border">Test</Button>
        </div>

        {/* Webhook */}
        <div className="space-y-2 border-b border-border pb-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Webhook</span>
            <Switch />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Webhook URL</Label>
            <Input placeholder="https://..." className="mt-1 bg-secondary border-border font-mono text-sm" />
          </div>
          <Button variant="outline" size="sm" className="text-xs border-border">Test</Button>
        </div>

        {/* Email */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Email</span>
            <Switch />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input placeholder="you@example.com" className="mt-1 bg-secondary border-border text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input placeholder="alerts@polysignal.com" className="mt-1 bg-secondary border-border text-sm" />
            </div>
          </div>
          <Button variant="outline" size="sm" className="text-xs border-border">Test</Button>
        </div>
      </section>

      {/* Watchlist */}
      <section className="bg-card border border-border rounded-lg p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Watchlist Management</h2>
        <div className="flex flex-wrap gap-2">
          {watchlist.map((slug) => (
            <Badge key={slug} variant="outline" className="border-border text-xs font-mono py-1 px-2 flex items-center gap-1.5">
              {slug}
              <button onClick={() => setWatchlist(watchlist.filter((s) => s !== slug))}>
                <X className="h-3 w-3 text-muted-foreground hover:text-destructive transition-colors" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Add market slug..."
            value={newSlug}
            onChange={(e) => setNewSlug(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSlug()}
            className="bg-secondary border-border font-mono text-sm max-w-xs"
          />
          <Button variant="outline" size="sm" className="text-xs border-border" onClick={addSlug}>Add</Button>
        </div>
      </section>

      {/* Scanner Health */}
      <section className="bg-card border border-border rounded-lg p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Scanner Health</h2>
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-muted-foreground">Last Run</span>
          <span className="font-mono">2026-03-03 14:30:00 UTC</span>
          <span className="text-muted-foreground">Markets Scanned</span>
          <span className="font-mono">10</span>
          <span className="text-muted-foreground">Signals Fired</span>
          <span className="font-mono text-bull">5</span>
          <span className="text-muted-foreground">Errors</span>
          <span className="font-mono text-bull">None</span>
          <span className="text-muted-foreground">Uptime</span>
          <span className="font-mono">99.7% (30d)</span>
        </div>
      </section>
    </div>
  );
};

export default SettingsPage;
