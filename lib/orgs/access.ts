import { and, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { appGuests, apps, orgMembers, users, type AppTeamAccess, type OrgRole } from "@/lib/db/schema";

/**
 * Who may do what. Every permission question in OpenDashboards is answered
 * here, from the database: a role is never taken from the caller.
 *
 * Two things decide access to an app. The member's role is the ceiling (a
 * viewer never builds), and the app's team access is what its owner granted
 * the rest of the org. The owner always has full access.
 */

/** Who is asking, and in which org. Both come from the verified session, never from the browser. */
export type Scope = { userId: string; orgId: string };

export type AppAccess = "owner" | "edit" | "view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** Building: creating apps, chatting with the Build agent, changing dashboards. */
export const canBuild = (role: OrgRole) => role !== "viewer";
/** Adding, changing, sharing and removing data connections. */
export const canManageConnections = (role: OrgRole) => role !== "viewer";
/** Inviting and removing members, changing roles, renaming the org. */
export const canManageMembers = (role: OrgRole) => role === "admin";

/** A member's access to one app of their org, or null when they have none. */
export function accessFor(app: { userId: string; teamAccess: AppTeamAccess }, userId: string, role: OrgRole): AppAccess | null {
  if (app.userId === userId) return "owner";
  if (app.teamAccess === "private") return null;
  // The role is the ceiling: a viewer only views, whatever the app grants the team.
  return app.teamAccess === "edit" && role !== "viewer" ? "edit" : "view";
}

/** Whether this access lets a member with this role change the app: build in it, rename it, edit its dashboards. */
export const canChange = (access: AppAccess, role: OrgRole) => access !== "view" && canBuild(role);

/** The user's role in an org, or null when they aren't a member. */
export async function roleIn(db: Database, userId: string, orgId: string | null): Promise<OrgRole | null> {
  if (!isUuid(orgId)) return null;
  const [row] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

export type AppGrant = {
  appId: string;
  orgId: string;
  ownerId: string;
  /** Their role in the app's workspace. A guest is treated as a viewer of this one app. */
  role: OrgRole;
  access: AppAccess;
  canChange: boolean;
  /** Not a member of the app's workspace: let in to view this app alone, by email. */
  guest: boolean;
};

/**
 * What the user may do with an app, or null: it doesn't exist, or nothing
 * lets them in. A member of its workspace gets what their role and the app's
 * team access allow. Anyone else gets in only as a guest: to view, if the app
 * lists the email they signed in with. Looked up by the app's own workspace,
 * not the one the user has open, so a link to an app works from anywhere.
 */
export async function appAccess(db: Database, userId: string, appId: string): Promise<AppGrant | null> {
  if (!isUuid(appId)) return null;
  const [row] = await db
    .select({ orgId: apps.orgId, ownerId: apps.userId, teamAccess: apps.teamAccess, role: orgMembers.role })
    .from(apps)
    .leftJoin(orgMembers, and(eq(orgMembers.orgId, apps.orgId), eq(orgMembers.userId, userId)))
    .where(eq(apps.id, appId))
    .limit(1);
  if (!row?.orgId) return null;
  const { orgId, ownerId } = row;
  const access = row.role ? accessFor({ userId: ownerId, teamAccess: row.teamAccess }, userId, row.role) : null;
  if (access && row.role) return { appId, orgId, ownerId, role: row.role, access, canChange: canChange(access, row.role), guest: false };
  // Not through the workspace: only as a guest of this app.
  if (!(await isGuest(db, userId, appId))) return null;
  return { appId, orgId, ownerId, role: "viewer", access: "view", canChange: false, guest: true };
}

/** Whether the app lists the email this user signed in with among its guests. */
export async function isGuest(db: Database, userId: string, appId: string): Promise<boolean> {
  const [row] = await db
    .select({ email: appGuests.email })
    .from(appGuests)
    .innerJoin(users, eq(users.email, appGuests.email))
    .where(and(eq(appGuests.appId, appId), eq(users.id, userId)))
    .limit(1);
  return Boolean(row);
}
