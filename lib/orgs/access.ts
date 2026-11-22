import { and, eq } from "drizzle-orm";

import type { Database } from "@/lib/db";
import { apps, orgMembers, type AppTeamAccess, type OrgRole } from "@/lib/db/schema";

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

export type AppGrant = { appId: string; orgId: string; ownerId: string; role: OrgRole; access: AppAccess; canChange: boolean };

/**
 * What the user may do with an app, or null: it doesn't exist, they aren't a
 * member of its org, or it isn't shared with them. Looked up by the app's own
 * org, not the one the user has open, so a link to an app works from anywhere.
 */
export async function appAccess(db: Database, userId: string, appId: string): Promise<AppGrant | null> {
  if (!isUuid(appId)) return null;
  const [row] = await db
    .select({ orgId: apps.orgId, ownerId: apps.userId, teamAccess: apps.teamAccess, role: orgMembers.role })
    .from(apps)
    .innerJoin(orgMembers, and(eq(orgMembers.orgId, apps.orgId), eq(orgMembers.userId, userId)))
    .where(eq(apps.id, appId))
    .limit(1);
  if (!row?.orgId) return null;
  const access = accessFor({ userId: row.ownerId, teamAccess: row.teamAccess }, userId, row.role);
  if (!access) return null;
  return { appId, orgId: row.orgId, ownerId: row.ownerId, role: row.role, access, canChange: canChange(access, row.role) };
}
