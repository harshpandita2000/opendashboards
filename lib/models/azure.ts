import "server-only";

import { AzureOpenAI, APIError } from "openai";

import { createGuardedFetch, type GuardedFetch, type GuardedFetchTestHooks } from "@/lib/net/guarded-fetch";

import type { AzureOpenAIConfig } from "./config";

/** Entra ID tokens for Azure OpenAI (Cognitive Services) data-plane calls. */
export const AZURE_COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default";

/** Longest one model request may take, streaming included: under the chat route's 300 s. */
const REQUEST_TIMEOUT_MS = 280_000;
/** A streamed turn's response, capped: far past any real completion. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export type AzureClient = { client: AzureOpenAI; model: string; close: () => Promise<void> };

export type AzureClientOptions = {
  testHooks?: GuardedFetchTestHooks;
  /** Tests only: stands in for Entra ID. */
  tokenProvider?: () => Promise<string>;
};

/**
 * An OpenAI client for an organisation's Azure OpenAI deployment. Every
 * request goes through a guarded fetch locked to the resource's origin
 * (HTTPS, public addresses, never ours, no redirects), so the key can't be
 * sent anywhere else. With Entra ID, a client-credentials token for the
 * Cognitive Services scope is sent instead of an API key.
 */
export async function createAzureClient(
  config: AzureOpenAIConfig,
  credential: string,
  options: AzureClientOptions = {},
): Promise<AzureClient> {
  const endpoint = new URL(config.endpoint);
  const guardedFetch: GuardedFetch = createGuardedFetch(
    { origin: endpoint.origin, maxBytes: MAX_RESPONSE_BYTES, timeoutMs: REQUEST_TIMEOUT_MS },
    options.testHooks,
  );
  const auth =
    config.authMode === "entra_client_credentials"
      ? {
          azureADTokenProvider: options.tokenProvider ?? (await entraTokenProvider(config, credential)),
          // The SDK falls back to AZURE_OPENAI_API_KEY from the environment when no key is
          // given, and refuses a key alongside a token provider. Null keeps the server's own
          // environment out of an organisation's client.
          apiKey: null as unknown as undefined,
        }
      : { apiKey: credential };
  const client = new AzureOpenAI({
    // An explicit base URL, so OPENAI_BASE_URL in the server's environment can't redirect
    // an organisation's traffic (the SDK reads it when baseURL is omitted).
    baseURL: `${endpoint.origin}/openai`,
    deployment: config.deployment,
    apiVersion: config.apiVersion,
    ...auth,
    fetch: guardedFetch as unknown as typeof fetch,
    maxRetries: 2,
    timeout: REQUEST_TIMEOUT_MS,
  });
  return { client, model: config.deployment, close: () => guardedFetch.close() };
}

async function entraTokenProvider(config: AzureOpenAIConfig, clientSecret: string): Promise<() => Promise<string>> {
  const { ClientSecretCredential, getBearerTokenProvider } = await import("@azure/identity");
  const credential = new ClientSecretCredential(config.tenantId!, config.clientId!, clientSecret);
  return getBearerTokenProvider(credential, AZURE_COGNITIVE_SCOPE);
}

export type ProviderCheck =
  | { ok: true; latencyMs: number; warning?: string }
  | { ok: false; code: "key_refused" | "not_found" | "bad_request" | "unreachable" | "upstream_error"; message: string };

/**
 * Checks a provider answers a tiny chat completion with this key. The
 * message names the likely cause, never the key or the server's own text
 * (which can echo request details).
 */
export async function testAzureProvider(
  config: AzureOpenAIConfig,
  credential: string,
  options: AzureClientOptions = {},
): Promise<ProviderCheck> {
  const startedAt = Date.now();
  let azure: AzureClient | undefined;
  try {
    azure = await createAzureClient(config, credential, options);
    await azure.client.chat.completions.create(
      {
        model: azure.model,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        max_completion_tokens: 256,
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      },
      { maxRetries: 0, timeout: 30_000 },
    );
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return describeFailure(error, startedAt);
  } finally {
    await azure?.close();
  }
}

/** Exported for tests. */
export function describeFailure(error: unknown, startedAt = Date.now()): ProviderCheck {
  if (error instanceof APIError && typeof error.status === "number") {
    if (error.status === 401 || error.status === 403) {
      return { ok: false, code: "key_refused", message: "Azure refused the credentials. Check the key (or the app registration's secret and its role on the resource)." };
    }
    if (error.status === 404) {
      return { ok: false, code: "not_found", message: "Azure found no such deployment. Check the deployment name and API version." };
    }
    if (error.status === 429) {
      // Throttled, but the endpoint, deployment and key all worked.
      return { ok: true, latencyMs: Date.now() - startedAt, warning: "Azure is rate-limiting this deployment right now (HTTP 429)." };
    }
    if (error.status === 400) {
      return { ok: false, code: "bad_request", message: "Azure rejected the test request (HTTP 400). Check the API version supports this model." };
    }
    return { ok: false, code: "upstream_error", message: `Azure had an error (HTTP ${error.status}). Try again.` };
  }
  return { ok: false, code: "unreachable", message: "Couldn't reach the endpoint. Check its address; it must be a public HTTPS endpoint." };
}
