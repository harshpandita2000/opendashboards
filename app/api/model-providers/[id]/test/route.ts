import { respond } from "@/lib/http";
import { getModelProviderService } from "@/lib/models";
import { actorOf, orgRoute } from "@/lib/orgs/route";

type Ctx = { params: Promise<{ id: string }> };

/** Checks a saved provider against Azure again and records the outcome. */
export const POST = orgRoute<Ctx>("admin", async (_request, org, { params }) => {
  const { id } = await params;
  return respond(await getModelProviderService().retest(actorOf(org), id));
});
