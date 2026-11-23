import { z } from "zod";

import { HttpError, readJson, respond } from "@/lib/http";
import { getModelProviderService } from "@/lib/models";
import { actorOf, orgRoute } from "@/lib/orgs/route";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({ isDefault: z.boolean() }).strict();

/** Body: { isDefault: true } makes it the organisation's chat model; false clears the default. */
export const PATCH = orgRoute<Ctx>("admin", async (request, org, { params }) => {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, "Expected { isDefault: boolean }");
  const service = getModelProviderService();
  const actor = actorOf(org);
  if (!parsed.data.isDefault) {
    const current = (await service.list(actor)).find((provider) => provider.id === id);
    if (!current) return respond({ ok: false, error: { code: "not_found", message: "No such model provider." } });
    if (!current.isDefault) return new Response(null, { status: 204 });
  }
  return respond(await service.setDefault(actor, parsed.data.isDefault ? id : null), { emptyOk: true });
});

export const DELETE = orgRoute<Ctx>("admin", async (_request, org, { params }) => {
  const { id } = await params;
  return respond(await getModelProviderService().remove(actorOf(org), id), { emptyOk: true });
});
