import { readJson, respond } from "@/lib/http";
import { getModelProviderService } from "@/lib/models";
import { actorOf, orgRoute } from "@/lib/orgs/route";

/**
 * The current organisation's model providers (admins only). The same service
 * as the settings page: a provider is checked against Azure before it's
 * saved, and its credential is sealed and never returned.
 */
export const GET = orgRoute("admin", async (_request, org) => {
  return Response.json({ providers: await getModelProviderService().list(actorOf(org)) });
});

/** Body: { name, config: { kind: "azure_openai", endpoint, deployment, apiVersion, authMode?, … }, credential, makeDefault? } */
export const POST = orgRoute("admin", async (request, org) => {
  const result = await getModelProviderService().create(actorOf(org), await readJson(request));
  return result.ok ? Response.json(result.data, { status: 201 }) : respond(result);
});
