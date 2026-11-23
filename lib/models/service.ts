import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/lib/db";
import { modelProviders, type ModelProviderRow } from "@/lib/db/schema";
import { logError } from "@/lib/log";
import { hasRole } from "@/lib/orgs/roles";
import type { OrgActor } from "@/lib/orgs/service";
import type { SecretBox, SecretContext } from "@/lib/secrets/types";

import type { ProviderCheck } from "./azure";
import { createModelProviderSchema, credentialHint, type ModelProviderConfig } from "./config";

export type ModelProviderSummary = {
  id: string;
  name: string;
  kind: ModelProviderRow["kind"];
  /** Endpoint, deployment, API version, auth mode: nothing secret. */
  config: ModelProviderConfig;
  credentialHint: string;
  isDefault: boolean;
  status: ModelProviderRow["status"];
  lastError: string | null;
  lastCheckedAt: Date | null;
};

export type ModelErrorCode = "validation" | "not_found" | "forbidden" | "check_failed" | "internal";
export type ModelResult<T = undefined> = { ok: true; data: T } | { ok: false; error: { code: ModelErrorCode; message: string; field?: string } };

const ok = <T>(data: T): ModelResult<T> => ({ ok: true, data });
const fail = (code: ModelErrorCode, message: string, field?: string): ModelResult<never> => ({ ok: false, error: { code, message, field } });
const forbidden = () => fail("forbidden", "Only admins can manage model providers.");
const notFound = () => fail("not_found", "This model provider doesn't exist or was deleted.");

export type ResolvedProvider = { id: string; name: string; config: ModelProviderConfig; credential: string };

export type ModelProviderServiceDeps = {
  db: Database;
  secrets: () => SecretBox;
  /** Checks a provider answers with this credential (lib/models/azure.ts). */
  test: (config: ModelProviderConfig, credential: string) => Promise<ProviderCheck>;
  now?: () => Date;
};

/** Model provider keys are bound to the provider row, its creator and its organisation. */
export const providerSecretContext = (row: { id: string; orgId: string; createdBy: string }): SecretContext => ({
  purpose: "model-provider-key",
  userId: row.createdBy,
  connectionId: row.id,
  orgId: row.orgId,
});

/**
 * An organisation's own model providers (Azure OpenAI deployments for now):
 * where the Build agent's model calls go instead of OpenDashboards' default.
 * Admins add, test, choose and delete them; the key is sealed with the
 * configured secret store and only opened server-side, to call the model.
 */
export function createModelProviderService(deps: ModelProviderServiceDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const summary = (row: ModelProviderRow): ModelProviderSummary => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: row.config,
    credentialHint: row.credentialHint,
    isDefault: row.isDefault,
    status: row.status,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt,
  });

  async function find(orgId: string, id: string) {
    if (!z.uuid().safeParse(id).success) return undefined;
    const [row] = await db
      .select()
      .from(modelProviders)
      .where(and(eq(modelProviders.id, id), eq(modelProviders.orgId, orgId)))
      .limit(1);
    return row;
  }

  async function guard<T>(operation: string, fn: () => Promise<ModelResult<T>>): Promise<ModelResult<T>> {
    try {
      return await fn();
    } catch (error) {
      logError(`modelProviders.${operation}`, error);
      return fail("internal", "Something went wrong. Try again.");
    }
  }

  const service = {
    async list(actor: OrgActor): Promise<ModelProviderSummary[]> {
      if (!hasRole(actor.role, "admin")) return [];
      const rows = await db.select().from(modelProviders).where(eq(modelProviders.orgId, actor.orgId)).orderBy(asc(modelProviders.createdAt));
      return rows.map(summary);
    },

    /** Checks the provider works, then saves it with its key sealed. A provider that fails its check isn't saved. */
    create(actor: OrgActor, input: unknown): Promise<ModelResult<{ id: string; warning?: string }>> {
      return guard("create", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        const parsed = createModelProviderSchema.safeParse(input);
        if (!parsed.success) {
          const issue = parsed.error.issues[0]!;
          return fail("validation", issue.message, issue.path.join(".") || undefined);
        }
        const { name, config, credential, makeDefault } = parsed.data;
        const check = await deps.test(config, credential);
        if (!check.ok) return fail("check_failed", check.message, "credential");

        const id = randomUUID();
        const secret = await deps.secrets().seal(credential, providerSecretContext({ id, orgId: actor.orgId, createdBy: actor.userId }));
        await db.transaction(async (tx) => {
          if (makeDefault) {
            await tx.update(modelProviders).set({ isDefault: false }).where(and(eq(modelProviders.orgId, actor.orgId), eq(modelProviders.isDefault, true)));
          }
          await tx.insert(modelProviders).values({
            id,
            orgId: actor.orgId,
            name,
            kind: config.kind,
            config,
            secret,
            credentialHint: credentialHint(credential),
            isDefault: makeDefault,
            status: "ok",
            lastError: check.warning ?? null,
            lastCheckedAt: now(),
            createdBy: actor.userId,
          });
        });
        return ok({ id, ...(check.warning ? { warning: check.warning } : {}) });
      });
    },

    /** Runs the check again and records the outcome. */
    retest(actor: OrgActor, id: string): Promise<ModelResult<{ status: "ok" | "invalid"; message: string | null }>> {
      return guard("retest", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        const row = await find(actor.orgId, id);
        if (!row) return notFound();
        const credential = await deps.secrets().open(row.secret, providerSecretContext(row));
        const check = await deps.test(row.config, credential);
        const status = check.ok ? "ok" : "invalid";
        const message = check.ok ? (check.warning ?? null) : check.message;
        await db
          .update(modelProviders)
          .set({ status, lastError: message, lastCheckedAt: now(), updatedAt: now() })
          .where(and(eq(modelProviders.id, row.id), eq(modelProviders.orgId, actor.orgId)));
        return ok({ status, message });
      });
    },

    /** Makes this the provider the organisation's Build agent uses, or (null) goes back to OpenDashboards' default. */
    setDefault(actor: OrgActor, id: string | null): Promise<ModelResult> {
      return guard("setDefault", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        if (id !== null && !(await find(actor.orgId, id))) return notFound();
        await db.transaction(async (tx) => {
          await tx.update(modelProviders).set({ isDefault: false }).where(and(eq(modelProviders.orgId, actor.orgId), eq(modelProviders.isDefault, true)));
          if (id !== null) {
            await tx.update(modelProviders).set({ isDefault: true, updatedAt: now() }).where(and(eq(modelProviders.id, id), eq(modelProviders.orgId, actor.orgId)));
          }
        });
        return ok(undefined);
      });
    },

    remove(actor: OrgActor, id: string): Promise<ModelResult> {
      return guard("remove", async () => {
        if (!hasRole(actor.role, "admin")) return forbidden();
        if (!z.uuid().safeParse(id).success) return notFound();
        const deleted = await db
          .delete(modelProviders)
          .where(and(eq(modelProviders.id, id), eq(modelProviders.orgId, actor.orgId)))
          .returning({ id: modelProviders.id });
        return deleted.length ? ok(undefined) : notFound();
      });
    },

    /**
     * The provider the organisation's model calls go to, key opened: its
     * default, if its last check passed. Null means OpenDashboards' default.
     * Server code only; the key never leaves the server.
     */
    async resolveDefault(orgId: string): Promise<ResolvedProvider | null> {
      const [row] = await db
        .select()
        .from(modelProviders)
        .where(and(eq(modelProviders.orgId, orgId), eq(modelProviders.isDefault, true), eq(modelProviders.status, "ok")))
        .limit(1);
      if (!row) return null;
      const credential = await deps.secrets().open(row.secret, providerSecretContext(row));
      return { id: row.id, name: row.name, config: row.config, credential };
    },
  };
  return service;
}

export type ModelProviderService = ReturnType<typeof createModelProviderService>;
