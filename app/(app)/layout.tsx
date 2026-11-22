import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AnalyticsUser } from "@/components/analytics-user";
import { AppsTree } from "@/components/shell/apps-tree";
import { Brand } from "@/components/shell/brand";
import { Footer } from "@/components/shell/footer";
import { NavLink } from "@/components/shell/nav-link";
import { OpenSidebarButton, Sidebar } from "@/components/shell/sidebar";
import { SidebarUser, SidebarUserFallback } from "@/components/shell/sidebar-user";
import { requireUser } from "@/lib/auth/user";

/** Everything in here is a signed-in user's own; only the landing page is for crawlers. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell flex h-dvh bg-neutral-50">
      <Suspense fallback={null}>
        <IdentifyUser />
      </Suspense>
      {/* The brand, the nav and the user. Beside the content on a wide screen, where it can be collapsed; floating over it on a phone. */}
      <Sidebar>
        <HomeLink className="mb-3 flex h-9 shrink-0 items-center px-2" />
        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          {/* The home page is where an app starts: its composer, then the app grid. */}
          <NavLink href="/apps" label="New App" icon="new" exact />
          {/* The apps, flat below it, take the leftover height and scroll, so what's below always shows. */}
          <div className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            <Suspense fallback={null}>
              <AppsTree />
            </Suspense>
          </div>
          <div className="shrink-0 border-t pt-2">
            <NavLink href="/connections" label="Data Connections" icon="connections" />
            <NavLink href="/settings" label="Workspace" icon="team" />
          </div>
        </nav>
        <div className="mt-1 shrink-0">
          <Suspense fallback={<SidebarUserFallback />}>
            <SidebarUser />
          </Suspense>
        </div>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* With the sidebar collapsed the left margin matches the right (app/globals.css). */}
        <main data-main className="relative mx-2 mt-2 min-h-0 flex-1 overflow-y-auto rounded-xl border bg-background md:ml-0">
          {/* The way back to a collapsed sidebar, on pages whose own header doesn't carry one. */}
          <OpenSidebarButton floating className="absolute top-2.5 left-2 z-10" />
          {children}
        </main>
        <Footer />
      </div>
    </div>
  );
}

async function IdentifyUser() {
  const user = await requireUser();
  return <AnalyticsUser id={user.id} email={user.email} />;
}

function HomeLink({ className }: { className?: string }) {
  return (
    <Link
      href="/connections"
      aria-label="OpenDashboards home"
      className={`rounded-md focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${className ?? ""}`}
    >
      <Brand />
    </Link>
  );
}
