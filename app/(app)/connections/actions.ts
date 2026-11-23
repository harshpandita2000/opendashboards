"use server";

import { refresh } from "next/cache";

import { track } from "@/lib/analytics";
import { getConnectionService } from "@/lib/connections";
import { startMcpSignIn } from "@/lib/connections/mcp-sign-in";
import type { Result } from "@/lib/connections/errors";
import { withLogContext } from "@/lib/log";
import { ForbiddenError, requireOrgRole } from "@/lib/orgs/current";
import type { Scope } from "@/lib/orgs/scope";

/*
 * Each action is a public POST endpoint: it authenticates itself, and the
 * service validates the input and scopes everything to the user's current
 * organisation. Viewers can't change connections; members change their own;
 * admins change any.
 * Inputs are typed `unknown` on purpose: nothing from the client is trusted.
 */

/** The member's scope, with their role; a viewer gets a "forbidden" result instead. */
async function memberScope(): Promise<Scope | Result<never>> {
  try {
    const { scope, role } = await requireOrgRole("member");
    return { orgId: scope.orgId, userId: scope.userId, role };
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: { code: "forbidden", message: "Viewers can't change data connections." } };
    throw error;
  }
}

async function run<T>(
  call: (scope: Scope) => Promise<Result<T>>,
  { refreshOnFailure = false } = {},
): Promise<Result<T>> {
  const scope = await memberScope();
  if ("ok" in scope) return scope;
  const result = await withLogContext({ user: scope.userId, org: scope.orgId }, () => call(scope));
  if (result.ok || refreshOnFailure) refresh();
  return result;
}

/**
 * Starts an OAuth sign-in to an MCP server (new, or again for an existing
 * connection). Returns the sign-in page to send the browser to; the
 * connection is saved when it comes back to /api/mcp/oauth/callback.
 */
export async function startMcpSignInAction(input: unknown) {
  const scope = await memberScope();
  if ("ok" in scope) return scope;
  return startMcpSignIn(scope, input);
}

export async function createConnectionAction(input: unknown) {
  return run(async (scope) => {
    const result = await getConnectionService().create(scope, input);
    const type = (input as { type?: unknown } | null)?.type;
    trackConnection(scope.userId, typeof type === "string" ? type : "unknown", false, result);
    return result;
  });
}

/** Refreshes on failure too: the check records the new status either way. */
export async function retestConnectionAction(input: unknown) {
  return run((scope) => getConnectionService().retest(scope, input), {
    refreshOnFailure: true,
  });
}

/** A new API key (PostHog) or password (Postgres) for a saved connection. */
export async function replaceCredentialAction(input: unknown) {
  return run((scope) => getConnectionService().replaceCredential(scope, input));
}

export async function renameConnectionAction(input: unknown) {
  return run((scope) => getConnectionService().rename(scope, input));
}

export async function deleteConnectionAction(input: unknown) {
  return run((scope) => getConnectionService().remove(scope, input));
}

/** Installs a demo dataset: a connection of the user's that points at it. */
export async function installDemoAction(input: unknown) {
  return run(async (scope) => {
    const result = await getConnectionService().installDemo(scope, input);
    trackConnection(scope.userId, "postgres", true, result);
    return result;
  });
}

/** Uninstalls a demo dataset, unless an app uses it. */
export async function uninstallDemoAction(input: unknown) {
  return run((scope) => getConnectionService().uninstallDemo(scope, input));
}

function trackConnection(userId: string, sourceType: string, isDemo: boolean, result: Result<unknown>) {
  if (result.ok) track(userId, "connection_created", { source_type: sourceType, is_demo: isDemo });
  // `field` is a form field's name ("host", "password"), never what was typed in it.
  else track(userId, "connection_failed", { source_type: sourceType, is_demo: isDemo, error_code: result.error.code, field: result.error.field ?? null });
}
