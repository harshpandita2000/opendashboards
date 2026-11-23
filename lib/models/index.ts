import "server-only";

import type OpenAI from "openai";

import { config as appConfig } from "@/config";
import { getDb } from "@/lib/db";
import { getSecretBox } from "@/lib/secrets";

import { createAzureClient, testAzureProvider } from "./azure";
import { createModelProviderService, type ModelProviderService } from "./service";

export type { ModelProviderSummary } from "./service";

let service: ModelProviderService | undefined;

export function getModelProviderService(): ModelProviderService {
  service ??= createModelProviderService({ db: getDb(), secrets: () => getSecretBox(), test: (config, credential) => testAzureProvider(config, credential) });
  return service;
}

/** Where one chat turn's model calls go: the organisation's provider, or OpenDashboards' default (OpenUI Gateway). */
export type ChatModel = {
  client: OpenAI;
  model: string;
  /** For the chat's error messages and metrics. */
  provider: "openui" | "azure_openai";
  providerName: string;
  /** Extra request fields the provider's model takes (reasoning effort). */
  extra: Record<string, unknown>;
  close: () => Promise<void>;
};

/**
 * The organisation's default model provider as a client, if it has one that
 * passed its check, else `fallback` (OpenUI Gateway with its model).
 */
export async function chatModelFor(orgId: string, fallback: () => OpenAI): Promise<ChatModel> {
  const provider = await getModelProviderService().resolveDefault(orgId);
  if (!provider) {
    return { client: fallback(), model: appConfig().openui.model, provider: "openui", providerName: "OpenUI Gateway", extra: {}, close: async () => {} };
  }
  const azure = await createAzureClient(provider.config, provider.credential);
  return {
    client: azure.client,
    model: azure.model,
    provider: "azure_openai",
    providerName: provider.name,
    extra: provider.config.reasoningEffort ? { reasoning_effort: provider.config.reasoningEffort } : {},
    close: azure.close,
  };
}
