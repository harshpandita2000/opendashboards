import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/lib/db";
import { orgInvites, orgMembers, orgs, type OrgRole } from "@/lib/db/schema";
import { logError } from "@/lib/log";

import { assignableRoles, hasRole } from "./roles";
import { orgSettingsSchema, type OrgSettings } from "./settings";

export type OrgErrorCode = "validation" | "not_found" | "forbidden" | "conflict" | "internal";
export type OrgError = { code: OrgErrorCode; message: string; field?: string };
export type OrgResult<T = undefined> = { ok: true; data: T } | { ok: false; error: OrgError };

const ok = <T>(data: T): OrgResult<T> => ({ ok: true, data });
const fail = (code: OrgErrorCode, message: string, field?: string): OrgResult<never> => ({ ok: false, error: { code, message, field } });
const forbidden = () => fail("forbidden", "Your role in this organisation can't do that.");
const notFound = () => fail("not_found", "Not found.");

/** An organisation as its member sees it. */
export type Membership = {
  id: string;
  name: string;
  role: OrgRole;
  personal: boolean;
  cloudUserId: string;
  settings: OrgSettings;
};

export type MemberSummary = { userId: string; email: string; role: OrgRole; createdAt: Date };
export type InviteSummary = { id: string; email: string; role: OrgRole; expiresAt: Date; createdAt: Date };

/** Who is acting: a member of the organisation, with their role (from `membership`, never the browser). */
export type OrgActor = { orgId: string; userId: string; role: OrgRole };

const nameSchema = z.string().trim().min(1, "Give the organisation a name.").max(80, "Keep the name under 80 characters.");
const inviteSchema = z
  .object({
    email: z.email("Enter an email address.").max(320).transform((email) => email.toLowerCase()),
    role: z.enum(["admin", "member", "viewer"]),
  })
  .strict();
const roleChangeSchema = z.object({ userId: z.string().min(1).max(200), role: z.enum(["admin", "member", "viewer"]) }).strict();

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Invitation tokens are only ever stored hashed: a database read can't be turned into a join link. */
export const hashInviteToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/**
 * Organisations: who belongs to which, with what role, and invitations.
 * Every user has a personal organisation (created on first sign-in, and by
 * the migration for users who existed before organisations) and may create
 * or join team organisations. Data (connections, apps, dashboards, model
 * providers) belongs to an organisation; see lib/orgs/scope.ts.
 */
export function createOrgService({ db, now = () => new Date() }: { db: Database; now?: () => Date }) {
  async function guard<T>(operation: string, fn: () => Promise<OrgResult<T>>): Promise<OrgResult<T>> {
    try {
      return await fn();
    } catch (error) {
      logError(`orgs.${operation}`, error);
      return fail("internal", "Something went wrong. Try again.");
    }
  }

  const service = {
    /**
     * The user's personal organisation, created (with them as owner) if it
     * doesn't exist yet. Keeps their membership email current for the
     * members list.
     */
    async ensurePersonal(user: { id: string; email: string }): Promise<string> {
      const [existing] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.personalFor, user.id)).limit(1);
      let orgId = existing?.id;
      if (!orgId) {
        await db
          .insert(orgs)
          .values({ name: "Personal", personalFor: user.id, openuiUserId: user.id, createdBy: user.id })
          .onConflictDoNothing();
        const [row] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.personalFor, user.id)).limit(1);
        orgId = row!.id;
      }
      await db
        .insert(orgMembers)
        .values({ orgId, userId: user.id, email: user.email, role: "owner" })
        .onConflictDoUpdate({
          target: [orgMembers.orgId, orgMembers.userId],
          set: { email: user.email },
          setWhere: sql`${orgMembers.email} <> ${user.email}`,
        });
      return orgId;
    },

    /** Every organisation the user belongs to, personal first. */
    async memberships(userId: string): Promise<Membership[]> {
      const rows = await db
        .select({
          id: orgs.id,
          name: orgs.name,
          role: orgMembers.role,
          personalFor: orgs.personalFor,
          cloudUserId: orgs.openuiUserId,
          settings: orgs.settings,
        })
        .from(orgMembers)
        .innerJoin(orgs, eq(orgs.id, orgMembers.orgId))
        .where(eq(orgMembers.userId, userId))
        .orderBy(sql`${orgs.personalFor} is null`, asc(orgs.name));
      return rows.map(({ personalFor, ...row }) => ({ ...row, personal: personalFor === userId }));
    },

    /** The user's role in an organisation, or null when they're not a member. */
    async roleOf(userId: string, orgId: string): Promise<OrgRole | null> {
      if (!z.uuid().safeParse(orgId).success) return null;
      const [row] = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
        .limit(1);
      return row?.role ?? null;
    },

    /** A team organisation, with the user as its owner. */
    create(user: { id: string; email: string }, input: unknown): Promise<OrgResult<{ id: string }>> {
      return guard("create", async () => {
        const parsed = z.object({ name: nameSchema }).strict().safeParse(input);
        if (!parsed.success) return fail("validation", parsed.error.issues[0]!.message, "name");
        const id = randomUUID();
        await db.transaction(async (tx) => {
          await tx.insert(orgs).values({ id, name: parsed.data.name, openuiUserId: `org_${id}`, createdBy: user.id });
          await tx.insert(orgMembers).values({ orgId: id, userId: user.id, email: user.email, role: "owner" });
        });
        return ok({ id });
      });
    },

    rename(actor: OrgActor, input: unknown): Promise<OrgResult> {
      return guard("rename", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        const parsed = z.object({ name: nameSchema }).strict().safeParse(input);
        if (!parsed.success) return fail("validation", parsed.error.issues[0]!.message, "name");
        await db.update(orgs).set({ name: parsed.data.name, updatedAt: now() }).where(eq(orgs.id, actor.orgId));
        return ok(undefined);
      });
    },

    async settings(orgId: string): Promise<OrgSettings> {
      const [row] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
      return row?.settings ?? {};
    },

    updateSettings(actor: OrgActor, input: unknown): Promise<OrgResult<OrgSettings>> {
      return guard("updateSettings", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        const parsed = orgSettingsSchema.safeParse(input);
        if (!parsed.success) return fail("validation", parsed.error.issues[0]!.message);
        const [row] = await db
          .update(orgs)
          .set({ settings: parsed.data, updatedAt: now() })
          .where(eq(orgs.id, actor.orgId))
          .returning({ settings: orgs.settings });
        return row ? ok(row.settings) : notFound();
      });
    },

    async members(actor: OrgActor): Promise<MemberSummary[]> {
      return db
        .select({ userId: orgMembers.userId, email: orgMembers.email, role: orgMembers.role, createdAt: orgMembers.createdAt })
        .from(orgMembers)
        .where(eq(orgMembers.orgId, actor.orgId))
        .orderBy(asc(orgMembers.createdAt));
    },

    /** Admins change roles; nobody changes the owner's, or hands out "owner". */
    changeRole(actor: OrgActor, input: unknown): Promise<OrgResult> {
      return guard("changeRole", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        const parsed = roleChangeSchema.safeParse(input);
        if (!parsed.success) return fail("validation", parsed.error.issues[0]!.message);
        if (!assignableRoles(actor.role).includes(parsed.data.role)) return forbidden();
        const current = await service.roleOf(parsed.data.userId, actor.orgId);
        if (!current) return notFound();
        if (current === "owner") return fail("forbidden", "The owner's role can't be changed.");
        await db
          .update(orgMembers)
          .set({ role: parsed.data.role })
          .where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, parsed.data.userId)));
        return ok(undefined);
      });
    },

    /** Removes a member (admins), or leaves (anyone but the owner). */
    removeMember(actor: OrgActor, userId: string): Promise<OrgResult> {
      return guard("removeMember", async () => {
        if (userId !== actor.userId && !hasRole(actor.role, "admin")) return forbidden();
        const current = await service.roleOf(userId, actor.orgId);
        if (!current) return notFound();
        if (current === "owner") return fail("forbidden", "The owner can't be removed or leave their organisation.");
        await db.delete(orgMembers).where(and(eq(orgMembers.orgId, actor.orgId), eq(orgMembers.userId, userId)));
        return ok(undefined);
      });
    },

    async invites(actor: OrgActor): Promise<InviteSummary[]> {
      if (!hasRole(actor.role, "admin")) return [];
      return db
        .select({ id: orgInvites.id, email: orgInvites.email, role: orgInvites.role, expiresAt: orgInvites.expiresAt, createdAt: orgInvites.createdAt })
        .from(orgInvites)
        .where(and(eq(orgInvites.orgId, actor.orgId), isNull(orgInvites.acceptedAt), gt(orgInvites.expiresAt, now())))
        .orderBy(asc(orgInvites.createdAt));
    },

    /**
     * Invites an email address with a role. Returns the one-time token for the
     * join link (shown once to the admin; only its hash is stored). Inviting
     * the same address again replaces the pending invitation.
     */
    invite(actor: OrgActor, input: unknown): Promise<OrgResult<{ id: string; token: string }>> {
      return guard("invite", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        const parsed = inviteSchema.safeParse(input);
        if (!parsed.success) return fail("validation", parsed.error.issues[0]!.message, String(parsed.error.issues[0]!.path[0] ?? ""));
        if (!assignableRoles(actor.role).includes(parsed.data.role)) return forbidden();
        const [personal] = await db.select({ personalFor: orgs.personalFor }).from(orgs).where(eq(orgs.id, actor.orgId)).limit(1);
        if (personal?.personalFor) return fail("validation", "Personal organisations are just for you. Create a team organisation to invite people.");
        const [member] = await db
          .select({ userId: orgMembers.userId })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, actor.orgId), sql`lower(${orgMembers.email}) = ${parsed.data.email}`))
          .limit(1);
        if (member) return fail("conflict", "That person is already a member.", "email");

        const token = randomBytes(32).toString("base64url");
        const id = randomUUID();
        await db.transaction(async (tx) => {
          await tx
            .delete(orgInvites)
            .where(and(eq(orgInvites.orgId, actor.orgId), eq(orgInvites.email, parsed.data.email), isNull(orgInvites.acceptedAt)));
          await tx.insert(orgInvites).values({
            id,
            orgId: actor.orgId,
            email: parsed.data.email,
            role: parsed.data.role,
            tokenHash: hashInviteToken(token),
            invitedBy: actor.userId,
            expiresAt: new Date(now().getTime() + INVITE_TTL_MS),
          });
        });
        return ok({ id, token });
      });
    },

    revokeInvite(actor: OrgActor, inviteId: string): Promise<OrgResult> {
      return guard("revokeInvite", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        if (!z.uuid().safeParse(inviteId).success) return notFound();
        const deleted = await db
          .delete(orgInvites)
          .where(and(eq(orgInvites.id, inviteId), eq(orgInvites.orgId, actor.orgId), isNull(orgInvites.acceptedAt)))
          .returning({ id: orgInvites.id });
        return deleted.length ? ok(undefined) : notFound();
      });
    },

    /** What a join link is for, to show before accepting. Null when it's unknown, used or expired. */
    async peekInvite(token: string): Promise<{ orgName: string; email: string; role: OrgRole } | null> {
      const [row] = await db
        .select({ orgName: orgs.name, email: orgInvites.email, role: orgInvites.role })
        .from(orgInvites)
        .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
        .where(and(eq(orgInvites.tokenHash, hashInviteToken(token)), isNull(orgInvites.acceptedAt), gt(orgInvites.expiresAt, now())))
        .limit(1);
      return row ?? null;
    },

    /**
     * Accepts an invitation, once, for the signed-in user whose (verified)
     * sign-in email matches the invited address. An existing member keeps
     * their role.
     */
    accept(user: { id: string; email: string }, token: string): Promise<OrgResult<{ orgId: string }>> {
      return guard("accept", async () => {
        if (typeof token !== "string" || token.length < 20 || token.length > 200) return notFound();
        return db.transaction(async (tx) => {
          const [invite] = await tx
            .select()
            .from(orgInvites)
            .where(and(eq(orgInvites.tokenHash, hashInviteToken(token)), isNull(orgInvites.acceptedAt), gt(orgInvites.expiresAt, now())))
            .for("update")
            .limit(1);
          if (!invite) return fail("not_found", "This invitation is invalid, expired or already used.");
          if (invite.email !== user.email.toLowerCase()) {
            return fail("forbidden", `This invitation is for ${invite.email}. Sign in with that address to accept it.`);
          }
          await tx
            .insert(orgMembers)
            .values({ orgId: invite.orgId, userId: user.id, email: user.email, role: invite.role })
            .onConflictDoNothing();
          await tx.update(orgInvites).set({ acceptedAt: now(), acceptedBy: user.id }).where(eq(orgInvites.id, invite.id));
          return ok({ orgId: invite.orgId });
        });
      });
    },

    /** Deletes a team organisation and everything in it. Owner only; personal organisations stay. */
    remove(actor: OrgActor): Promise<OrgResult> {
      return guard("remove", async () => {
        if (actor.role !== "owner") return forbidden();
        const [row] = await db.select({ personalFor: orgs.personalFor }).from(orgs).where(eq(orgs.id, actor.orgId)).limit(1);
        if (!row) return notFound();
        if (row.personalFor) return fail("forbidden", "Your personal organisation can't be deleted.");
        await db.delete(orgs).where(eq(orgs.id, actor.orgId));
        return ok(undefined);
      });
    },
  };
  return service;
}

export type OrgService = ReturnType<typeof createOrgService>;
