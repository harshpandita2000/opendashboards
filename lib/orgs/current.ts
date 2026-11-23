import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { requireUser, type CurrentUser } from "@/lib/auth/user";
import { HttpError } from "@/lib/http";

import { getOrgService, type Membership } from ".";
import { hasRole, type OrgRole } from "./roles";
import type { CloudScope } from "./scope";

/** The browser's choice of organisation. Only a preference: checked against membership on every request. */
export const ORG_COOKIE = "od_org";

/** The signed-in user acting in their current organisation. */
export type OrgContext = {
  user: CurrentUser;
  org: Membership;
  role: OrgRole;
  /** For data calls: the organisation, the user, and the organisation's OpenUI Cloud identity. */
  scope: CloudScope;
  memberships: Membership[];
};

/**
 * The signed-in user and the organisation they're working in: the one their
 * cookie names if they're (still) a member, otherwise their personal one,
 * created on first sign-in. Cached per request. Call it wherever
 * `requireUser` was called for data.
 */
export const requireOrg = cache(async (): Promise<OrgContext> => {
  const user = await requireUser();
  const service = getOrgService();
  const personalId = await service.ensurePersonal(user);
  const memberships = await service.memberships(user.id);
  const wanted = (await cookies()).get(ORG_COOKIE)?.value;
  const org = memberships.find((m) => m.id === wanted) ?? memberships.find((m) => m.id === personalId) ?? memberships[0]!;
  return {
    user,
    org,
    role: org.role,
    scope: { orgId: org.id, userId: user.id, cloudUserId: org.cloudUserId },
    memberships,
  };
});

export class ForbiddenError extends HttpError {
  constructor(message = "Your role in this organisation can't do that.") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

/** The current organisation, if the user's role there is at least `role`; otherwise a 403. */
export async function requireOrgRole(role: OrgRole): Promise<OrgContext> {
  const context = await requireOrg();
  if (!hasRole(context.role, role)) throw new ForbiddenError();
  return context;
}
