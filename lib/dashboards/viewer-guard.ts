import "server-only";

import type { CloudScope } from "@/lib/orgs/scope";

import { readDashboard } from ".";
import { compileProgram, isCallAllowed, type CompiledProgram } from "./viewer-policy";

const MAX_CACHED = 200;
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; compiled: CompiledProgram }>();

/**
 * Whether a viewer's data call is one the dashboard's stored program makes
 * (lib/dashboards/viewer-policy.ts). Programs are read from OpenUI Cloud as
 * the organisation and compiled once per dashboard version, for a few minutes.
 */
export async function viewerMayRun(
  scope: CloudScope,
  dashboard: { appId: string; artifactId: string; version?: string },
  call: { name: string; arguments?: Record<string, unknown> },
): Promise<boolean> {
  const key = `${scope.orgId}:${dashboard.artifactId}:${dashboard.version ?? ""}`;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.at > TTL_MS) {
    const read = await readDashboard(scope, dashboard.appId, dashboard.artifactId);
    if (!read.ok) return false;
    entry = { at: Date.now(), compiled: compileProgram(read.program) };
    cache.set(key, entry);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return isCallAllowed(entry.compiled, call.name, call.arguments ?? {});
}
