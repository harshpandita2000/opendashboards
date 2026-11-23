import { getThreadService } from "@/lib/apps";
import { readJson, respond } from "@/lib/http";
import { orgRoute } from "@/lib/orgs/route";

type Ctx = { params: Promise<{ appId: string; threadId: string }> };

/** Renames a thread in the app's list. */
export const PATCH = orgRoute<Ctx>("member", async (request, { scope }, { params }) => {
  const { appId, threadId } = await params;
  const result = await getThreadService().rename(scope, appId, threadId, await readJson(request));
  return respond(result, { emptyOk: true });
});

/** Removes a thread from the app. The client deletes the Cloud conversation first. */
export const DELETE = orgRoute<Ctx>("member", async (_request, { scope }, { params }) => {
  const { appId, threadId } = await params;
  return respond(await getThreadService().remove(scope, appId, threadId), { emptyOk: true });
});
