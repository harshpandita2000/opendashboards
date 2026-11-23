import type { OrgRole } from "@/lib/db/schema";

/**
 * Who a data call is for: the organisation whose data it reads or writes, and
 * the signed-in user acting in it. Every service query filters on `orgId`;
 * `userId` is recorded as who created a row, and binds that row's secrets.
 * Both always come from the verified session and membership, never from the
 * browser (lib/orgs/current.ts).
 */
export type Scope = {
  orgId: string;
  userId: string;
  /**
   * The user's role, when the call is a member's own action. Members change
   * only rows they created; admins and owners change any. Absent for calls
   * the server makes on the user's behalf (a dashboard refreshing an OAuth
   * token, say), which change nothing a role guards.
   */
  role?: OrgRole;
};

/**
 * A scope plus the organisation's OpenUI Cloud identity: the "user" OpenUI
 * Cloud stores its dashboards and conversations under. A personal
 * organisation keeps the user's own id (so dashboards made before
 * organisations existed stay readable); a team organisation has its own.
 */
export type CloudScope = Scope & { cloudUserId: string };
