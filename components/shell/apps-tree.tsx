import { getAppService } from "@/lib/apps";
import { requireMember } from "@/lib/orgs";

import { AppsTreeNav } from "./apps-tree-nav";

/**
 * Every app the user can open in the org they have open, newest first, each with its dashboards nested
 * below. The sidebar gives this list the leftover height and scrolls it.
 * Reads the request, so it renders behind Suspense.
 */
export async function AppsTree() {
  const apps = await getAppService().tree(await requireMember());

  if (!apps.length) {
    return <p className="py-1.5 pl-7 text-xs text-muted-foreground">No apps yet</p>;
  }
  return <AppsTreeNav apps={apps} />;
}
