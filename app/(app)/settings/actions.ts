"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { config } from "@/config";
import { getConnectionService } from "@/lib/connections";
import { withLogContext } from "@/lib/log";
import { getModelProviderService } from "@/lib/models";
import { getOrgService, type OrgActor } from "@/lib/orgs";
import { ORG_COOKIE, requireOrg } from "@/lib/orgs/current";
import { requireUser } from "@/lib/auth/user";

/*
 * Organisation settings. Like every Server Action, each is a public POST
 * endpoint: it authenticates itself, resolves the user's current organisation
 * and role from the database (never from the browser), and the services check
 * the role again. Inputs are `unknown`: nothing from the client is trusted.
 */

type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; field?: string } };

async function actor(): Promise<OrgActor> {
  const { org, user, role } = await requireOrg();
  return { orgId: org.id, userId: user.id, role };
}

async function run<T>(call: (actor: OrgActor) => Promise<Result<T>>): Promise<Result<T>> {
  const current = await actor();
  const result = await withLogContext({ user: current.userId, org: current.orgId }, () => call(current));
  if (result.ok) refresh();
  return result;
}

const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: config().env !== "local", path: "/", maxAge: 60 * 60 * 24 * 365 };

/** Switches the organisation the user works in. Only one they belong to. */
export async function switchOrgAction(orgId: unknown): Promise<Result> {
  const user = await requireUser();
  if (typeof orgId !== "string" || !(await getOrgService().roleOf(user.id, orgId))) {
    return { ok: false, error: { code: "not_found", message: "You're not a member of that organisation." } };
  }
  (await cookies()).set(ORG_COOKIE, orgId, cookieOptions);
  redirect("/apps");
}

/** Creates a team organisation and switches to it. */
export async function createOrgAction(input: unknown): Promise<Result> {
  const user = await requireUser();
  const result = await getOrgService().create(user, input);
  if (!result.ok) return result;
  (await cookies()).set(ORG_COOKIE, result.data.id, cookieOptions);
  redirect("/settings");
}

export async function renameOrgAction(input: unknown) {
  return run((current) => getOrgService().rename(current, input));
}

export async function deleteOrgAction(): Promise<Result> {
  const current = await actor();
  const result = await getOrgService().remove(current);
  if (!result.ok) return result;
  (await cookies()).delete(ORG_COOKIE);
  redirect("/apps");
}

export async function updateOrgSettingsAction(input: unknown) {
  return run(async (current) => {
    const result = await getOrgService().updateSettings(current, input);
    return result.ok ? { ok: true as const, data: undefined } : result;
  });
}

/** Invites someone; returns the join link, shown once (only its hash is stored). */
export async function inviteAction(input: unknown): Promise<Result<{ link: string }>> {
  return run(async (current) => {
    const result = await getOrgService().invite(current, input);
    if (!result.ok) return result;
    return { ok: true, data: { link: new URL(`/invite/${result.data.token}`, config().appOrigin).href } };
  });
}

export async function revokeInviteAction(inviteId: unknown) {
  return run((current) => getOrgService().revokeInvite(current, String(inviteId)));
}

export async function changeRoleAction(input: unknown) {
  return run((current) => getOrgService().changeRole(current, input));
}

export async function removeMemberAction(userId: unknown) {
  return run((current) => getOrgService().removeMember(current, String(userId)));
}

/** Leaves the current organisation and goes back to the personal one. */
export async function leaveOrgAction(): Promise<Result> {
  const current = await actor();
  const result = await getOrgService().removeMember(current, current.userId);
  if (!result.ok) return result;
  (await cookies()).delete(ORG_COOKIE);
  redirect("/apps");
}

/** Accepts an invitation for the signed-in user and switches to its organisation. */
export async function acceptInviteAction(token: unknown): Promise<Result> {
  const user = await requireUser();
  await getOrgService().ensurePersonal(user);
  const result = await getOrgService().accept(user, String(token));
  if (!result.ok) return result;
  (await cookies()).set(ORG_COOKIE, result.data.orgId, cookieOptions);
  redirect("/apps");
}

export async function addModelProviderAction(input: unknown) {
  return run((current) => getModelProviderService().create(current, input));
}

export async function retestModelProviderAction(id: unknown) {
  return run((current) => getModelProviderService().retest(current, String(id)));
}

export async function setDefaultModelProviderAction(id: unknown) {
  return run((current) => getModelProviderService().setDefault(current, id === null ? null : String(id)));
}

export async function deleteModelProviderAction(id: unknown) {
  return run((current) => getModelProviderService().remove(current, String(id)));
}

export async function setMcpAllowedToolsAction(input: unknown) {
  return run((current) => getConnectionService().setMcpAllowedTools({ orgId: current.orgId, userId: current.userId, role: current.role }, input));
}
