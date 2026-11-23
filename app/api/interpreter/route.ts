import { OpenUIApiError, ToolExecutionError } from "@openuidev/server";
import { z } from "zod";

import { track } from "@/lib/analytics";
import { getDashboardService, getDashboards } from "@/lib/dashboards";
import { SIGN_IN_LOST_HEADER } from "@/lib/dashboards/sign-in-lost";
import { HttpError, readJson } from "@/lib/http";
import { viewerMayRun } from "@/lib/dashboards/viewer-guard";
import { hasRole } from "@/lib/orgs/roles";
import { orgRoute } from "@/lib/orgs/route";
import { addLogContext, logError } from "@/lib/log";

const requestSchema = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
  id: z.string().min(1).max(200),
  version: z.string().max(200).optional(),
});

/** Total budget for one data call, the dashboard's tools included. */
const TIMEOUT_MS = 120_000;

/** The 2-minute data budget above, plus headroom to answer when it runs out. */
export const maxDuration = 150;

/**
 * Runs a live dashboard's data calls. The dashboard must be in the user's
 * current organisation, and the app its tools record usage against comes
 * from OpenDashboards' own record of the dashboard, never from the request.
 * A viewer's call runs only if the dashboard's own program makes it.
 */
export const POST = orgRoute("viewer", async (request, { user, role, scope }) => {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, "Invalid interpreter request");

  const dashboard = await getDashboardService().findByArtifact(scope, parsed.data.id);
  if (!dashboard) throw new HttpError(404, "Dashboard not found");
  addLogContext({ app: dashboard.appId, dashboard: parsed.data.id });
  if (!hasRole(role, "member")) {
    const allowed = await viewerMayRun(scope, { appId: dashboard.appId, artifactId: parsed.data.id, version: parsed.data.version }, parsed.data);
    if (!allowed) {
      return Response.json(
        { error: { code: "viewer_not_allowed", message: "Viewers can run only the queries this dashboard was built with." } },
        { status: 403 },
      );
    }
  }

  // A data call that finds a sign-in expired says so in a header, even when the
  // dashboard's script caught the error: the page then refreshes to show "Sign in again".
  let signInLost = false;
  const headers = (): HeadersInit => (signInLost ? { [SIGN_IN_LOST_HEADER]: "1" } : {});
  const context = {
    userId: scope.cloudUserId,
    orgId: scope.orgId,
    actorUserId: user.id,
    appId: dashboard.appId,
    onSignInLost: () => (signInLost = true),
  };

  try {
    const result = await getDashboards().interpreter.execute(parsed.data, context, { signal: request.signal, timeoutMs: TIMEOUT_MS });
    return Response.json({ result }, { headers: headers() });
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      track(user.id, "dashboard_query_failed", {
        app_id: dashboard.appId,
        dashboard_id: parsed.data.id,
        tool: parsed.data.name,
        error_code: error.code,
      });
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status ?? 400, headers: headers() });
    }
    if (error instanceof OpenUIApiError) {
      logError("interpreter", error);
      return Response.json({ error: { code: "openui_error", message: error.message } }, { status: 502 });
    }
    throw error;
  }
});
