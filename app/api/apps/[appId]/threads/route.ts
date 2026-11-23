import { getThreadService } from "@/lib/apps";
import { ownsConversation } from "@/lib/apps/cloud-threads";
import { registerThreadSchema } from "@/lib/apps/schemas";
import { HttpError, readJson, respond } from "@/lib/http";
import { orgRoute } from "@/lib/orgs/route";

type Ctx = { params: Promise<{ appId: string }> };

/** The app's chat threads, newest activity first. `?cursor=` pages. */
export const GET = orgRoute<Ctx>("member", async (request, { scope }, { params }) => {
  const { appId } = await params;
  const cursor = new URL(request.url).searchParams.get("cursor");
  return respond(await getThreadService().list(scope, appId, cursor));
});

/**
 * Registers a thread just created in OpenUI Cloud as belonging to the app,
 * once Cloud confirms the conversation is the organisation's.
 */
export const POST = orgRoute<Ctx>("member", async (request, { scope }, { params }) => {
  const { appId } = await params;
  const input = await readJson(request);
  const parsed = registerThreadSchema.safeParse(input);
  if (parsed.success && !(await ownsConversation(scope.cloudUserId, parsed.data.threadId))) {
    throw new HttpError(404, "Conversation not found");
  }
  return respond(await getThreadService().register(scope, appId, input));
});
