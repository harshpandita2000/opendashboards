import type { OrgRole } from "@/lib/db/schema";

export type { OrgRole };

export const ORG_ROLES = ["owner", "admin", "member", "viewer"] as const satisfies readonly OrgRole[];

const RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

/**
 * Whether `role` can do what `required` can. Owners can do everything;
 * admins manage members, invitations, model providers and policies; members
 * build (connections, apps, the Build chat); viewers only open dashboards,
 * and their dashboard queries are limited to what each dashboard runs.
 */
export function hasRole(role: OrgRole, required: OrgRole): boolean {
  return RANK[role] >= RANK[required];
}

/** Roles an admin may hand out: never owner (there's one, the creator), and admins can't mint peers above themselves. */
export function assignableRoles(actor: OrgRole): OrgRole[] {
  if (actor === "owner") return ["admin", "member", "viewer"];
  if (actor === "admin") return ["admin", "member", "viewer"];
  return [];
}

export const ROLE_LABELS: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
