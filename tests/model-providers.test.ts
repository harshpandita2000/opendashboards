import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { eq, sql } from "drizzle-orm";
import { APIError } from "openai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/lib/db";
import { modelProviders, orgs } from "@/lib/db/schema";
import { createAzureClient, describeFailure, testAzureProvider } from "@/lib/models/azure";
import { azureOpenAIConfigSchema, credentialHint, normalizeAzureEndpoint, type AzureOpenAIConfig } from "@/lib/models/config";
import { createModelProviderService } from "@/lib/models/service";
import type { ProviderCheck } from "@/lib/models/azure";
import { createOrgService, type OrgActor } from "@/lib/orgs/service";
import { createAesGcmSecretBox, parseAesKeys } from "@/lib/secrets/aes-gcm";

import { TEST_DATABASE_URL } from "./global-setup";

const API_KEY = "azure-key-0123456789abcdef";

describe("Azure OpenAI settings", () => {
  const valid = { kind: "azure_openai", endpoint: "https://ey-foundry.openai.azure.com/", deployment: "gpt-4.1", apiVersion: "2025-04-01-preview" };

  it("keeps only the resource from a pasted endpoint", () => {
    expect(normalizeAzureEndpoint("https://ey-foundry.openai.azure.com/openai/deployments/gpt-4.1/chat/completions")).toBe(
      "https://ey-foundry.openai.azure.com/",
    );
    expect(normalizeAzureEndpoint(" https://ey.cognitiveservices.azure.com ")).toBe("https://ey.cognitiveservices.azure.com/");
  });

  it.each(["http://ey.openai.azure.com/", "https://user:pw@ey.openai.azure.com/", "https://ey.openai.azure.com/?x=1", "https://ey.openai.azure.com/other", "nope"])(
    "refuses %j",
    (endpoint) => expect(normalizeAzureEndpoint(endpoint)).toBeNull(),
  );

  it("defaults to an API key and validates deployment and API version", () => {
    expect(azureOpenAIConfigSchema.parse(valid)).toMatchObject({ authMode: "api_key" });
    expect(azureOpenAIConfigSchema.safeParse({ ...valid, deployment: "../x" }).success).toBe(false);
    expect(azureOpenAIConfigSchema.safeParse({ ...valid, apiVersion: "latest" }).success).toBe(false);
    expect(azureOpenAIConfigSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it("needs a tenant and client id for Entra ID", () => {
    expect(azureOpenAIConfigSchema.safeParse({ ...valid, authMode: "entra_client_credentials" }).success).toBe(false);
    expect(
      azureOpenAIConfigSchema.safeParse({
        ...valid,
        authMode: "entra_client_credentials",
        tenantId: "5b973f99-77df-4beb-b27d-aa0c70b8482c",
        clientId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      }).success,
    ).toBe(true);
  });

  it("hints at a credential with its last four characters at most", () => {
    expect(credentialHint(API_KEY)).toBe("…cdef");
    expect(credentialHint("short")).toBe("set");
  });
});

describe("the Azure OpenAI adapter", () => {
  let server: http.Server;
  let base: string;
  const seen: { path: string; apiKey?: string; authorization?: string; body: unknown }[] = [];
  let status = 200;

  const hooks = { allowAddress: (address: string) => address === "127.0.0.1", allowHttp: true };
  const config = (overrides: Partial<AzureOpenAIConfig> = {}): AzureOpenAIConfig => ({
    kind: "azure_openai",
    endpoint: `${base}/`,
    deployment: "gpt-4.1",
    apiVersion: "2025-04-01-preview",
    authMode: "api_key",
    ...overrides,
  });

  beforeEach(async () => {
    seen.length = 0;
    status = 200;
    if (server) return;
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          apiKey: req.headers["api-key"] as string | undefined,
          authorization: req.headers.authorization,
          body: body ? JSON.parse(body) : null,
        });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          status === 200
            ? JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "gpt-4.1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }] })
            : JSON.stringify({ error: { code: String(status), message: `echo ${API_KEY}` } }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it("calls the deployment with the API version and the key in the api-key header", async () => {
    const check = await testAzureProvider(config({ reasoningEffort: "low" }), API_KEY, { testHooks: hooks });
    expect(check).toMatchObject({ ok: true });
    expect(seen[0].path).toBe("/openai/deployments/gpt-4.1/chat/completions?api-version=2025-04-01-preview");
    expect(seen[0].apiKey).toBe(API_KEY);
    expect(seen[0].body).toMatchObject({ reasoning_effort: "low", messages: [{ role: "user" }] });
  });

  it("sends an Entra ID bearer token instead of a key", async () => {
    const tokenProvider = async () => "entra-token";
    const check = await testAzureProvider(
      config({ authMode: "entra_client_credentials", tenantId: "5b973f99-77df-4beb-b27d-aa0c70b8482c", clientId: "0f8fad5b-d9cb-469f-a165-70867728950e" }),
      "client-secret",
      { testHooks: hooks, tokenProvider },
    );
    expect(check).toMatchObject({ ok: true });
    expect(seen[0].authorization).toBe("Bearer entra-token");
    expect(seen[0].apiKey).toBeUndefined();
  });

  it("names the likely cause of a failure, never echoing the server's text or the key", async () => {
    for (const [code, expected] of [
      [401, "key_refused"],
      [404, "not_found"],
      [400, "bad_request"],
      [500, "upstream_error"],
    ] as const) {
      status = code;
      const check = await testAzureProvider(config(), API_KEY, { testHooks: hooks });
      expect(check).toMatchObject({ ok: false, code: expected });
      expect(JSON.stringify(check)).not.toContain(API_KEY);
    }
    status = 429;
    expect(await testAzureProvider(config(), API_KEY, { testHooks: hooks })).toMatchObject({ ok: true, warning: expect.stringMatching(/429/) });
  });

  it("can't be pointed at a private address in production", async () => {
    const check = await testAzureProvider(config({ endpoint: "https://127.0.0.1/" }), API_KEY);
    expect(check).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("streams tool-calling turns through the same client", async () => {
    const azure = await createAzureClient(config(), API_KEY, { testHooks: hooks });
    const response = await azure.client.chat.completions.create({ model: azure.model, messages: [{ role: "user", content: "hi" }] });
    expect(response.choices[0]?.message.content).toBe("OK");
    await azure.close();
  });

  it("maps errors without a status as unreachable", () => {
    expect(describeFailure(new Error("socket hang up"))).toMatchObject({ ok: false, code: "unreachable" });
    expect(describeFailure(new APIError(403, undefined, "x", undefined))).toMatchObject({ code: "key_refused" });
  });
});

describe("model provider service", () => {
  const { db, pool } = createDatabase(TEST_DATABASE_URL);
  const orgService = createOrgService({ db });
  const secrets = createAesGcmSecretBox(parseAesKeys(randomBytes(32).toString("base64")));
  let check: ProviderCheck = { ok: true, latencyMs: 5 };
  const tested: string[] = [];
  const service = createModelProviderService({
    db,
    secrets: () => secrets,
    test: async (_config, credential) => {
      tested.push(credential);
      return check;
    },
  });
  const input = (overrides: object = {}) => ({
    name: "EY gpt-4.1",
    credential: API_KEY,
    config: { kind: "azure_openai", endpoint: "https://ey.openai.azure.com/", deployment: "gpt-4.1", apiVersion: "2025-04-01-preview" },
    ...overrides,
  });

  async function org(owner: string): Promise<OrgActor> {
    const created = await orgService.create({ id: owner, email: `${owner}@x.test` }, { name: owner });
    if (!created.ok) throw new Error(created.error.code);
    return { orgId: created.data.id, userId: owner, role: "owner" };
  }

  beforeEach(async () => {
    check = { ok: true, latencyMs: 5 };
    tested.length = 0;
    await db.execute(sql`TRUNCATE ${orgs} CASCADE`);
  });
  afterAll(() => pool.end());

  it("checks, then saves with the key sealed, and uses it as the organisation's model", async () => {
    const owner = await org("alice");
    const created = await service.create(owner, input());
    if (!created.ok) throw new Error(created.error.code);
    const [row] = await db.select().from(modelProviders).where(eq(modelProviders.id, created.data.id));
    expect(row.secret).toMatchObject({ provider: "aes-gcm", org: true });
    expect(JSON.stringify(row)).not.toContain(API_KEY);
    expect(row.credentialHint).toBe("…cdef");
    expect(await service.resolveDefault(owner.orgId)).toMatchObject({ id: created.data.id, credential: API_KEY, config: { deployment: "gpt-4.1" } });
    const [summary] = await service.list(owner);
    expect(JSON.stringify(summary)).not.toContain(API_KEY);
    expect(summary).not.toHaveProperty("secret");
  });

  it("doesn't save a provider that fails its check", async () => {
    const owner = await org("alice");
    check = { ok: false, code: "key_refused", message: "Azure refused the credentials." };
    expect(await service.create(owner, input())).toMatchObject({ ok: false, error: { code: "check_failed", field: "credential" } });
    expect(await service.list(owner)).toEqual([]);
    expect(await service.resolveDefault(owner.orgId)).toBeNull();
  });

  it("is admins' business only", async () => {
    const owner = await org("alice");
    for (const role of ["member", "viewer"] as const) {
      const actor = { ...owner, userId: "bob", role };
      expect(await service.create(actor, input())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await service.list(actor)).toEqual([]);
    }
    expect(tested).toEqual([]);
  });

  it("keeps one default, and falls back to the default model when it's unset or failing", async () => {
    const owner = await org("alice");
    const first = await service.create(owner, input({ name: "First" }));
    const second = await service.create(owner, input({ name: "Second" }));
    if (!first.ok || !second.ok) throw new Error("create failed");
    expect((await service.list(owner)).filter((p) => p.isDefault).map((p) => p.name)).toEqual(["Second"]);
    await service.setDefault(owner, first.data.id);
    expect((await service.resolveDefault(owner.orgId))?.name).toBe("First");
    check = { ok: false, code: "key_refused", message: "refused" };
    expect(await service.retest(owner, first.data.id)).toEqual({ ok: true, data: { status: "invalid", message: "refused" } });
    expect(await service.resolveDefault(owner.orgId)).toBeNull();
    await service.setDefault(owner, null);
    expect((await service.list(owner)).some((p) => p.isDefault)).toBe(false);
  });

  it("never lets one organisation see, use or change another's provider", async () => {
    const a = await org("alice");
    const b = await org("mallory");
    const created = await service.create(a, input());
    if (!created.ok) throw new Error(created.error.code);
    expect(await service.list(b)).toEqual([]);
    expect(await service.resolveDefault(b.orgId)).toBeNull();
    expect(await service.retest(b, created.data.id)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await service.setDefault(b, created.data.id)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await service.remove(b, created.data.id)).toMatchObject({ ok: false, error: { code: "not_found" } });
    // A sealed key copied into another organisation's row doesn't open.
    const other = await service.create(b, input({ name: "B" }));
    if (!other.ok) throw new Error(other.error.code);
    const [rowA] = await db.select().from(modelProviders).where(eq(modelProviders.id, created.data.id));
    await db.update(modelProviders).set({ secret: rowA.secret }).where(eq(modelProviders.id, other.data.id));
    await expect(service.resolveDefault(b.orgId)).rejects.toThrow();
  });
});
