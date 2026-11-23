import { z } from "zod";

import { isHost } from "@/lib/sources/host";

/**
 * Where an organisation's model provider points, and how it signs in. Safe
 * for the browser: the API key or client secret is the provider's sealed
 * secret, never here.
 */

export const AZURE_AUTH_MODES = ["api_key", "entra_client_credentials"] as const;
export type AzureAuthMode = (typeof AZURE_AUTH_MODES)[number];

/** Azure OpenAI's GA and preview API versions look like 2024-10-21 or 2025-04-01-preview. */
const API_VERSION = /^\d{4}-\d{2}-\d{2}(-preview)?$/;
/** Azure deployment names: letters, digits, '-', '_' and '.', up to 64. */
const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The resource endpoint: https, a real host, no path beyond "/", no user info, query or fragment. Exported for tests. */
export function normalizeAzureEndpoint(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (!isHost(url.hostname.replace(/^\[(.*)\]$/, "$1"))) return null;
  // People paste the full chat URL from the portal; keep only the resource.
  if (url.pathname !== "/" && !/^\/openai(\/.*)?$/.test(url.pathname)) return null;
  return `${url.origin}/`;
}

export const azureOpenAIConfigSchema = z
  .object({
    kind: z.literal("azure_openai"),
    endpoint: z.string().transform((value, ctx) => {
      const endpoint = normalizeAzureEndpoint(value);
      if (!endpoint) {
        ctx.addIssue({ code: "custom", message: "Enter the resource endpoint, like https://my-resource.openai.azure.com/." });
        return z.NEVER;
      }
      return endpoint;
    }),
    deployment: z.string().trim().regex(DEPLOYMENT, "Enter the deployment name from Azure AI Foundry, like gpt-4.1."),
    apiVersion: z.string().trim().regex(API_VERSION, "Enter an API version like 2025-04-01-preview."),
    authMode: z.enum(AZURE_AUTH_MODES).default("api_key"),
    /** Entra ID only. */
    tenantId: z.string().trim().regex(UUID, "Enter the directory (tenant) ID.").optional(),
    /** Entra ID only. */
    clientId: z.string().trim().regex(UUID, "Enter the application (client) ID.").optional(),
    /** For reasoning models (o-series, gpt-5): low | medium | high. Ignored otherwise. */
    reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.authMode === "entra_client_credentials") {
      if (!config.tenantId) ctx.addIssue({ code: "custom", path: ["tenantId"], message: "Enter the directory (tenant) ID." });
      if (!config.clientId) ctx.addIssue({ code: "custom", path: ["clientId"], message: "Enter the application (client) ID." });
    }
  });

export type AzureOpenAIConfig = z.infer<typeof azureOpenAIConfigSchema>;
export type ModelProviderConfig = AzureOpenAIConfig;

/** What a form submits to add a provider. The credential is the API key, or the client secret for Entra ID. */
export const createModelProviderSchema = z.object({
  name: z.string().trim().min(1, "Give it a name.").max(80),
  config: azureOpenAIConfigSchema,
  credential: z.string().trim().min(1, "Enter the key.").max(4096),
  makeDefault: z.boolean().default(true),
});

/** A credential hint: never more than the last four characters. */
export function credentialHint(credential: string): string {
  const tail = credential.slice(-4);
  return credential.length > 8 ? `…${tail}` : "set";
}
