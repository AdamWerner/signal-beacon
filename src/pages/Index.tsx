import { useSignals } from "@/hooks/useSignals";
import { SignalCard } from "@/components/SignalCard";

const SignalFeed = () => {
  const { data: signals } = useSignals();

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Signal Feed</h1>
        <span className="text-xs font-mono text-muted-foreground">{signals.length} signals</span>
      </div>
      {signals.map((signal) => (
        <SignalCard key={signal.id} signal={signal} />
      ))}
    </div>
  );
};

export default SignalFeed;
