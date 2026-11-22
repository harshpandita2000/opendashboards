import { getAppService } from "@/lib/apps";
import { requireMember } from "@/lib/orgs";

import { AppsTreeNav } from "./apps-tree-nav";

/**
 * Every app the user can open in the workspace they have open, newest first,
 * each with its dashboards nested below; then the apps of other workspaces
 * they were let into as a guest. The sidebar gives this list the leftover
 * height and scrolls it. Reads the request, so it renders behind Suspense.
 */
export async function AppsTree() {
  const member = await requireMember();
  const [apps, shared] = await Promise.all([getAppService().tree(member), getAppService().sharedWithGuest(member.userId)]);

  return (
    <>
      {apps.length ? <AppsTreeNav apps={apps} /> : <p className="py-1.5 pl-7 text-xs text-muted-foreground">No apps yet</p>}
      {shared.length > 0 && (
        <>
          <p className="mt-4 mb-1 px-2 text-xs font-medium text-muted-foreground">Shared with you</p>
          <AppsTreeNav apps={shared} />
        </>
      )}
    </>
  );
}
