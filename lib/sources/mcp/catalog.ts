import { z } from "zod";

import { isHost } from "../host";
import type { SourceCatalog } from "../types";

import { MCP_SERVICE_KEYS, mcpService } from "./services";

/**
 * A remote MCP server: its endpoint, which header carries the API key, how to
 * talk to it, and which of its tools may be used. Safe for the browser: the
 * key and any other auth headers are the (sealed) credential, never here.
 */

export const MCP_TRANSPORTS = ["auto", "streamable_http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/;

/** Headers the transport sets itself, or that would change where or how a request goes. */
export const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

/** The server's endpoint: HTTPS, a real host, no user info or fragment. Exported for tests. */
export function normalizeMcpUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  if (!isHost(url.hostname.replace(/^\[(.*)\]$/, "$1"))) return null;
  return url.href;
}

const mcpSettingsSchema = z
  .object({
    url: z.string().transform((value, ctx) => {
      const url = normalizeMcpUrl(value);
      if (!url) {
        ctx.addIssue({ code: "custom", message: "Enter the server's https:// endpoint, like https://mcp.example.com/mcp." });
        return z.NEVER;
      }
      return url;
    }),
    /** "Authorization" sends `Bearer <key>`; any other header sends the key as is. */
    headerName: z
      .string()
      .trim()
      .default("Authorization")
      .pipe(
        z
          .string()
          .regex(/^[A-Za-z0-9-]{1,64}$/, "Use a header name like Authorization or X-API-Key.")
          .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), "That header is set by OpenDashboards itself; choose another."),
      ),
    /** A known server from the catalog (lib/sources/mcp/services.ts). Absent for any other server. */
    service: z.enum(MCP_SERVICE_KEYS).optional(),
    /**
     * "auto" tries Streamable HTTP and falls back to the older HTTP+SSE
     * transport when the endpoint doesn't speak it; or pin one.
     */
    transport: z.enum(MCP_TRANSPORTS).optional(),
    /**
     * The only tools members' agents and dashboards may use, by name, set by
     * an admin. Absent or null: every tool the server marks read-only or
     * doesn't annotate.
     */
    allowedTools: z.array(z.string().regex(MCP_TOOL_NAME, "Use tool names exactly as the server lists them.")).max(200).nullable().optional(),
  })
  .strict();

/**
 * What a form submits. For a known server the endpoint and header come from
 * its preset, whatever the browser sent: a preset can't be pointed elsewhere.
 */
export const mcpConfigSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || !("service" in input)) return input;
  const preset = mcpService(String((input as { service: unknown }).service));
  return preset ? { ...input, url: preset.url, headerName: "Authorization" } : input;
}, mcpSettingsSchema);

/** Connecting with a key (or none): refused for a known server that only supports signing in. */
const mcpKeyConfigSchema = mcpConfigSchema.superRefine((config, ctx) => {
  const preset = mcpService(config.service);
  if (preset && !preset.auth.includes("key")) {
    ctx.addIssue({ code: "custom", path: ["service"], message: `${preset.label} only supports signing in, not an API key.` });
  }
});

const httpsUrl = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Must be an https:// URL.");

/**
 * What OAuth needs later, set by OpenDashboards when the user signs in, never
 * typed: the server's authorization server and token endpoint (for refreshing),
 * and the resource the tokens are for. Nothing here is secret.
 */
export const mcpOAuthSettingsSchema = z
  .object({
    /** Where the authorization server was discovered, and the issuer it named (they must match). */
    issuer: httpsUrl,
    tokenEndpoint: httpsUrl,
    /** How the token endpoint wants the client to authenticate. */
    tokenAuthMethods: z.array(z.string().max(64)).max(10).optional(),
    revocationEndpoint: httpsUrl.optional(),
    /**
     * The resource the tokens are for (RFC 8707): the server's own identifier.
     * Also the key a shared dashboard would use to find a viewer's own sign-in.
     */
    resource: z.string().max(2_048),
    scope: z.string().max(2_000).optional(),
  })
  .strict();

/** Settings as stored: what was typed, plus the OAuth details for a server signed in to. */
export const mcpStoredConfigSchema = mcpSettingsSchema.extend({ oauth: mcpOAuthSettingsSchema.optional() }).strict();

export type McpOAuthSettings = z.infer<typeof mcpOAuthSettingsSchema>;
export type McpConfig = z.infer<typeof mcpStoredConfigSchema>;

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
export const MAX_EXTRA_HEADERS = 10;

/**
 * Extra auth headers, as typed: one "Name: value" per line. Exported for the
 * form and tests. Returns the headers, or the first problem.
 */
export function parseHeaderLines(text: string): { ok: true; headers: [string, string][] } | { ok: false; message: string } {
  const headers: [string, string][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return { ok: false, message: "Write one header per line, like X-Tenant: acme." };
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!HEADER_NAME.test(name)) return { ok: false, message: `${name.slice(0, 64)} isn't a valid header name.` };
    if (RESERVED_HEADERS.has(name.toLowerCase())) return { ok: false, message: `${name} is set by OpenDashboards itself.` };
    if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: `Enter a value for ${name} (one line, up to 4,096 characters).` };
    if (headers.some(([existing]) => existing.toLowerCase() === name.toLowerCase())) return { ok: false, message: `${name} is listed twice.` };
    headers.push([name, value]);
  }
  if (headers.length > MAX_EXTRA_HEADERS) return { ok: false, message: `Up to ${MAX_EXTRA_HEADERS} extra headers.` };
  return { ok: true, headers };
}

/** An API key plus extra auth headers, as the one sealed credential. */
export type McpKeyCredential = { key: string; headers: [string, string][] };

/**
 * Packs a key and extra headers into the credential string that's sealed.
 * Just a key stays the key itself, as before extra headers existed.
 */
export function writeMcpKeyCredential({ key, headers }: McpKeyCredential): string {
  if (!headers.length) return key;
  return JSON.stringify({ kind: "headers", v: 1, key, headers });
}

/** The inverse of `writeMcpKeyCredential`: anything that isn't the packed form is a plain key. */
export function readMcpKeyCredential(credential: string): McpKeyCredential {
  if (credential.startsWith("{")) {
    try {
      const parsed = JSON.parse(credential) as { kind?: unknown; key?: unknown; headers?: unknown };
      if (parsed.kind === "headers" && typeof parsed.key === "string" && Array.isArray(parsed.headers)) {
        const headers = (parsed.headers as unknown[]).filter(
          (pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string"),
        );
        return { key: parsed.key, headers };
      }
    } catch {
      // A key that happens to start with "{".
    }
  }
  return { key: credential, headers: [] };
}

/**
 * The key, or nothing for a public server; or the packed key and extra
 * headers, whose headers are checked like typed ones.
 * The size that matters is checked in bytes when it's stored (lib/secrets): this only stops absurd input.
 */
export const mcpKeySchema = z
  .string()
  .trim()
  .max(65_536, "That key is too long.")
  .superRefine((credential, ctx) => {
    const { headers } = readMcpKeyCredential(credential);
    if (!headers.length) return;
    const checked = parseHeaderLines(headers.map(([name, value]) => `${name}: ${value}`).join("\n"));
    if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.message });
  });

export const mcpCatalog: SourceCatalog<McpConfig, "mcp"> = {
  // What a form may submit: never the OAuth details, which only a finished sign-in sets.
  type: "mcp",
  label: "MCP server",
  blurb: "Any remote MCP server, with a sign-in or an API key",
  tile: "MC",
  configSchema: mcpKeyConfigSchema as unknown as z.ZodType<McpConfig>,
  describe: (config) => {
    const url = new URL(config.url);
    const detail = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    const preset = mcpService(config.service);
    if (preset) return { source: preset.label, shortSource: preset.label, detail, tile: preset.tile };
    return { source: "MCP server", shortSource: "MCP", detail, tile: "MC" };
  },
};
