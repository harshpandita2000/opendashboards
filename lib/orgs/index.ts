import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { requireUser, type CurrentUser } from "@/lib/auth/user";
import { getDb } from "@/lib/db";
import type { OrgRole } from "@/lib/db/schema";
import { logError } from "@/lib/log";

import { appAccess, type AppGrant } from "./access";
import { createOrgService, type OrgService, type OrgSummary } from "./service";

export type { AppAccess, AppGrant, Scope } from "./access";
export type { OrgDetail, OrgInvite, OrgMember, OrgSummary } from "./service";

/** Which workspace the user has open. Only a preference: membership is checked on every request. */
export const ACTIVE_ORG_COOKIE = "od_org";

/** Where someone with no workspace is sent: the one thing they can do there is create one. */
export const NO_WORKSPACE_PATH = "/welcome";

let service: OrgService | undefined;

export function getOrgService(): OrgService {
  service ??= createOrgService({ db: getDb() });
  return service;
}

/** The signed-in user in the workspace they have open. Passes as a `Scope` to the services. */
export type Member = {
  user: CurrentUser;
  userId: string;
  orgId: string;
  role: OrgRole;
  /** The open workspace's name. */
  orgName: string;
  /** Every workspace they're in, the one they've been in longest first. */
  orgs: OrgSummary[];
};

// Per process: who has had rows from before workspaces moved into one.
const adopted = new Set<string>();

/**
 * The signed-in user and the workspace they have open: the one named by the
 * `od_org` cookie if they're still a member of it, otherwise the one they've
 * been in longest. Null when they're in none. Sets the user up the first time
 * they're seen.
 */
export const currentMember = cache(async (): Promise<Member | null> => {
  const user = await requireUser();
  const orgs = getOrgService();
  if (!(await orgs.isKnown(user))) await orgs.ensureUser(user);

  const mine = await orgs.list(user.id);
  if (!mine.length) return null;
  const wanted = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const open = mine.find((org) => org.id === wanted) ?? mine[0];

  if (!adopted.has(user.id)) {
    adopted.add(user.id);
    await orgs.adoptOrphans(user.id).catch((error) => {
      adopted.delete(user.id);
      logError("orgs.adoptOrphans", error);
    });
  }
  return { user, userId: user.id, orgId: open.id, role: open.role, orgName: open.name, orgs: mine };
});

/**
 * The signed-in user in their open workspace. Someone in no workspace is sent
 * to create one first: nothing else works without one. Call it wherever
 * something belongs to a workspace; like `requireUser`, it reads the request,
 * so in a page or layout it must run inside `<Suspense>`.
 */
export async function requireMember(): Promise<Member> {
  return (await currentMember()) ?? redirect(NO_WORKSPACE_PATH);
}

/** What the signed-in user may do with an app, or null. Cached per request. */
export const getAppGrant = cache(async (appId: string): Promise<AppGrant | null> => {
  const user = await requireUser();
  return appAccess(getDb(), user.id, appId);
});
