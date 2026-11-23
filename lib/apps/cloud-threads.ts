import "server-only";

import { config } from "@/config";
import { getOpenUI } from "@/lib/dashboards";

/**
 * Whether an OpenUI Cloud conversation belongs to this organisation's Cloud
 * identity. Asked with that identity's frontend token, which reaches only its
 * conversations, so a thread id from the browser is never taken on trust.
 */
export async function ownsConversation(cloudUserId: string, conversationId: string): Promise<boolean> {
  const { token } = await getOpenUI().createFrontendToken({ userId: cloudUserId });
  const response = await fetch(
    `${config().openui.apiUrl}/v1/conversations/${encodeURIComponent(conversationId)}`,
    { headers: { "x-thesys-frontend-token": token }, cache: "no-store" },
  );
  return response.ok;
}
