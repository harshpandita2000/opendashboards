import "server-only";

import { route } from "@/lib/http";
import { withLogContext } from "@/lib/log";

import { requireOrgRole, type OrgContext } from "./current";
import type { OrgRole } from "./roles";
import type { OrgActor } from "./service";

/**
 * Wraps a Route Handler like `route`, and resolves the user's current
 * organisation, refusing (403) a role below `role`.
 */
export function orgRoute<Ctx>(role: OrgRole, handler: (request: Request, org: OrgContext, ctx: Ctx) => Promise<Response>) {
  return route<Ctx>(async (request, _user, ctx) => {
    const org = await requireOrgRole(role);
    return withLogContext({ org: org.org.id }, () => handler(request, org, ctx));
  });
}

/** The caller as an actor for organisation-level services (roles checked there too). */
export const actorOf = ({ scope, role }: OrgContext): OrgActor => ({ orgId: scope.orgId, userId: scope.userId, role });
