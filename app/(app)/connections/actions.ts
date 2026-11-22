"use server";

import { refresh } from "next/cache";

import { track } from "@/lib/analytics";
import { getConnectionService } from "@/lib/connections";
import { startMcpSignIn } from "@/lib/connections/mcp-sign-in";
import type { Result } from "@/lib/connections/errors";
import { withLogContext } from "@/lib/log";
import { requireMember, type Member } from "@/lib/orgs";

/*
 * Each action is a public POST endpoint: it authenticates itself, and the
 * service validates the input and checks what the signed-in user may do in
 * the org they have open (or, for an existing connection, in its own org).
 * Inputs are typed `unknown` on purpose: nothing from the client is trusted.
 */

async function run<T>(
  call: (member: Member) => Promise<Result<T>>,
  { refreshOnFailure = false } = {},
): Promise<Result<T>> {
  const member = await requireMember();
  const result = await withLogContext({ user: member.userId }, () => call(member));
  if (result.ok || refreshOnFailure) refresh();
  return result;
}

/**
 * Starts an OAuth sign-in to an MCP server (new, or again for an existing
 * connection). Returns the sign-in page to send the browser to; the
 * connection is saved when it comes back to /api/mcp/oauth/callback.
 */
export async function startMcpSignInAction(input: unknown) {
  return startMcpSignIn(await requireMember(), input);
}

export async function createConnectionAction(input: unknown) {
  return run(async (member) => {
    const result = await getConnectionService().create(member, input);
    const type = (input as { type?: unknown } | null)?.type;
    trackConnection(member.userId, typeof type === "string" ? type : "unknown", false, result);
    return result;
  });
}

/** Refreshes on failure too: the check records the new status either way. */
export async function retestConnectionAction(input: unknown) {
  return run(({ userId }) => getConnectionService().retest(userId, input), {
    refreshOnFailure: true,
  });
}

/** A new API key (PostHog) or password (Postgres) for a saved connection. */
export async function replaceCredentialAction(input: unknown) {
  return run(({ userId }) => getConnectionService().replaceCredential(userId, input));
}

export async function renameConnectionAction(input: unknown) {
  return run(({ userId }) => getConnectionService().rename(userId, input));
}

export async function deleteConnectionAction(input: unknown) {
  return run(({ userId }) => getConnectionService().remove(userId, input));
}

/** Shares a sign-in with the whole team, or makes it personal again. Only whoever signed in can. */
export async function setConnectionSharingAction(input: unknown) {
  return run(async ({ userId }) => {
    const result = await getConnectionService().setSharing(userId, input);
    const sharing = (input as { sharing?: unknown } | null)?.sharing;
    if (result.ok) track(userId, "connection_sharing_changed", { sharing: sharing === "org" ? "org" : "personal" });
    return result;
  });
}

/** Installs a demo dataset: a connection of the org's that points at it. */
export async function installDemoAction(input: unknown) {
  return run(async (member) => {
    const result = await getConnectionService().installDemo(member, input);
    trackConnection(member.userId, "postgres", true, result);
    return result;
  });
}

/** Uninstalls a demo dataset, unless an app uses it. */
export async function uninstallDemoAction(input: unknown) {
  return run((member) => getConnectionService().uninstallDemo(member, input));
}

function trackConnection(userId: string, sourceType: string, isDemo: boolean, result: Result<unknown>) {
  if (result.ok) track(userId, "connection_created", { source_type: sourceType, is_demo: isDemo });
  // `field` is a form field's name ("host", "password"), never what was typed in it.
  else track(userId, "connection_failed", { source_type: sourceType, is_demo: isDemo, error_code: result.error.code, field: result.error.field ?? null });
}
