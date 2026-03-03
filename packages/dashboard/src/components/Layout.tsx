import { Outlet } from "react-router-dom";
import { StatusBar } from "@/components/StatusBar";
import { AppSidebar } from "@/components/AppSidebar";

export function Layout() {
  return (
    <div className="min-h-screen flex w-full bg-background">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <StatusBar />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
