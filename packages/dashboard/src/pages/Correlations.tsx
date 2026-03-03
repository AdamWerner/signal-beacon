import { useState } from "react";
import { useCorrelations } from "@/hooks/useCorrelations";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CorrelationsPage = () => {
  const { data: correlations } = useCorrelations();
  const [open, setOpen] = useState(false);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Correlation Map</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="text-xs border-border">
              + Add Correlation
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-card border-border">
            <DialogHeader>
              <DialogTitle>Add Correlation</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div>
                <Label className="text-xs text-muted-foreground">Polymarket Slug</Label>
                <Input placeholder="e.g. fed-rate-hike-june" className="mt-1 bg-secondary border-border font-mono text-sm" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Keywords</Label>
                <Input placeholder="e.g. federal reserve, interest rate" className="mt-1 bg-secondary border-border text-sm" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Avanza Instrument</Label>
                <Input placeholder="e.g. BEAR SP500 X2 AVA" className="mt-1 bg-secondary border-border font-mono text-sm" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Polarity</Label>
                <select className="mt-1 w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground">
                  <option value="DIRECT">DIRECT (odds up → instrument up)</option>
                  <option value="INVERSE">INVERSE (odds up → instrument down)</option>
                </select>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Notes</Label>
                <Input placeholder="Optional notes..." className="mt-1 bg-secondary border-border text-sm" />
              </div>
              <Button className="w-full bg-bull text-primary-foreground hover:bg-bull/90 text-sm">Save Correlation</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="space-y-3">
        {correlations.map((c) => (
          <div key={c.id} className="flex items-center gap-4 bg-card border border-border rounded-lg p-4">
            {/* Left: Polymarket */}
            <div className="flex-1 bg-secondary/30 rounded-md p-3">
              <p className="text-xs text-muted-foreground mb-1">Polymarket</p>
              <p className="text-sm font-medium">{c.polymarket}</p>
              <span className="text-xs font-mono text-muted-foreground">{(c.polymarket_odds * 100).toFixed(0)}% odds</span>
            </div>

            {/* Arrow */}
            <div className="flex flex-col items-center gap-1 shrink-0">
              <ArrowRight className={`h-5 w-5 ${c.polarity === "DIRECT" ? "text-bull" : "text-bear"}`} />
              <span className={`text-[10px] font-mono font-bold uppercase ${c.polarity === "DIRECT" ? "text-bull" : "text-bear"}`}>
                {c.polarity}
              </span>
            </div>

            {/* Right: Instrument */}
            <div className="flex-1 bg-secondary/30 rounded-md p-3">
              <p className="text-xs text-muted-foreground mb-1">Avanza Instrument</p>
              <p className="text-sm font-medium font-mono">{c.instrument}</p>
              <Badge
                variant="outline"
                className={`text-[10px] mt-1 ${c.instrument_type === "BULL" ? "border-bull/30 text-bull" : "border-bear/30 text-bear"}`}
              >
                {c.instrument_type}
              </Badge>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CorrelationsPage;
