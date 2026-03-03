import { Zap, Eye, GitBranch, Anchor, Settings } from "lucide-react";
import { NavLink } from "@/components/NavLink";

const navItems = [
  { title: "Signal Feed", url: "/", icon: Zap },
  { title: "Market Watch", url: "/markets", icon: Eye },
  { title: "Correlations", url: "/correlations", icon: GitBranch },
  { title: "Whale Tracker", url: "/whales", icon: Anchor },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  return (
    <aside className="w-16 hover:w-48 transition-all duration-300 bg-sidebar border-r border-border flex flex-col shrink-0 group overflow-hidden">
      <div className="p-3 border-b border-border flex items-center gap-2 h-10">
        <Zap className="h-4 w-4 text-bull shrink-0" />
        <span className="text-sm font-semibold text-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          PolySignal
        </span>
      </div>
      <nav className="flex-1 py-2">
        {navItems.map((item) => (
          <NavLink
            key={item.url}
            to={item.url}
            end={item.url === "/"}
            className="flex items-center gap-3 px-5 py-2.5 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
            activeClassName="bg-sidebar-accent text-bull border-r-2 border-bull"
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="text-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              {item.title}
            </span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
