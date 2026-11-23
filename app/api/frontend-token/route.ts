import { getOpenUI } from "@/lib/dashboards";
import { orgRoute } from "@/lib/orgs/route";

/**
 * The OpenUI Cloud frontend token for the user's current organisation: the
 * browser reads the organisation's dashboards and chat threads with it. It
 * reads only that organisation's artifacts.
 */
export const POST = orgRoute("viewer", async (_request, { scope }) => {
  return Response.json(await getOpenUI().createFrontendToken({ userId: scope.cloudUserId }));
});
