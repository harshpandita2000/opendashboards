import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import {
  appConnections,
  apps,
  dashboards,
  dataConnections,
  type ConnectionStatus,
} from "@/lib/db/schema";
import type { ConnectionType } from "@/lib/sources/catalog";
import { logError } from "@/lib/log";
import { hasRole } from "@/lib/orgs/roles";
import type { Scope } from "@/lib/orgs/scope";

import { fail, fromValidation, internalError, notFound, ok, type AppResult } from "./errors";
import { addAppConnectionSchema, appIdSchema, appRefSchema, createAppSchema, renameAppSchema } from "./schemas";

export type AppConnectionBadge = { id: string; name: string };

export type AppSummary = {
  id: string;
  name: string;
  updatedAt: Date;
  dashboardCount: number;
  connections: AppConnectionBadge[];
};

export type AppTreeNode = { id: string; name: string; dashboards: { id: string; title: string }[] };

export type AppDetail = {
  id: string;
  name: string;
  pendingPrompt: string | null;
  /** The data sources picked for the pending prompt, by name. */
  pendingConnections: AppConnectionBadge[];
  createdAt: Date;
  updatedAt: Date;
  dashboards: { id: string; title: string; description: string | null; artifactId: string; position: number }[];
  connections: (AppConnectionBadge & { type: ConnectionType; status: ConnectionStatus; signIn: "oauth" | null })[];
};

/**
 * The data access layer for apps. Like connections, every query is scoped to
 * the caller's organisation: another organisation's app looks exactly like a
 * missing one. Who may change what (roles) is checked by the callers.
 */
export function createAppService({ db, now = () => new Date() }: { db: Database; now?: () => Date }) {
  async function owns(scope: Scope, appId: string) {
    const [row] = await db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.id, appId), eq(apps.orgId, scope.orgId)))
      .limit(1);
    return Boolean(row);
  }

  async function guard<T>(operation: string, fn: () => Promise<AppResult<T>>): Promise<AppResult<T>> {
    try {
      return await fn();
    } catch (error) {
      logError(`apps.${operation}`, error);
      return internalError();
    }
  }

  async function connectionBadges(appIds: string[]) {
    if (!appIds.length) return [];
    return db
      .select({
        appId: appConnections.appId,
        id: dataConnections.id,
        name: dataConnections.name,
        type: dataConnections.type,
        status: dataConnections.status,
        config: dataConnections.config,
      })
      .from(appConnections)
      .innerJoin(dataConnections, eq(dataConnections.id, appConnections.connectionId))
      .where(inArray(appConnections.appId, appIds))
      .orderBy(asc(dataConnections.name));
  }

  const service = {
    /** The user's apps, most recently updated first. */
    async list(scope: Scope, { limit }: { limit?: number } = {}): Promise<AppSummary[]> {
      const query = db
        .select({
          id: apps.id,
          name: apps.name,
          updatedAt: apps.updatedAt,
          dashboardCount: count(dashboards.id),
        })
        .from(apps)
        .leftJoin(dashboards, eq(dashboards.appId, apps.id))
        .where(eq(apps.orgId, scope.orgId))
        .groupBy(apps.id)
        .orderBy(desc(apps.updatedAt), desc(apps.id));
      const rows = limit ? await query.limit(limit) : await query;

      const badges = await connectionBadges(rows.map((row) => row.id));
      return rows.map((row) => ({
        ...row,
        connections: badges
          .filter((badge) => badge.appId === row.id)
          .map(({ id, name }) => ({ id, name })),
      }));
    },

    /** Apps with their dashboards' titles, for the sidebar tree. Newest app first. */
    async tree(scope: Scope): Promise<AppTreeNode[]> {
      const appRows = await db
        .select({ id: apps.id, name: apps.name })
        .from(apps)
        .where(eq(apps.orgId, scope.orgId))
        .orderBy(desc(apps.updatedAt), desc(apps.id));
      if (!appRows.length) return [];

      const dashboardRows = await db
        .select({ appId: dashboards.appId, id: dashboards.id, title: dashboards.title })
        .from(dashboards)
        .where(eq(dashboards.orgId, scope.orgId))
        .orderBy(asc(dashboards.position), asc(dashboards.createdAt));

      return appRows.map((app) => ({
        ...app,
        dashboards: dashboardRows
          .filter((dashboard) => dashboard.appId === app.id)
          .map(({ id, title }) => ({ id, title })),
      }));
    },

    async get(scope: Scope, appId: string): Promise<AppDetail | null> {
      if (!appIdSchema.safeParse(appId).success) return null;
      const [app] = await db
        .select({
          id: apps.id,
          name: apps.name,
          pendingPrompt: apps.pendingPrompt,
          pendingConnectionIds: apps.pendingConnectionIds,
          createdAt: apps.createdAt,
          updatedAt: apps.updatedAt,
        })
        .from(apps)
        .where(and(eq(apps.id, appId), eq(apps.orgId, scope.orgId)))
        .limit(1);
      if (!app) return null;

      const appDashboards = await db
        .select({
          id: dashboards.id,
          title: dashboards.title,
          description: dashboards.description,
          artifactId: dashboards.artifactId,
          position: dashboards.position,
        })
        .from(dashboards)
        .where(eq(dashboards.appId, app.id))
        .orderBy(asc(dashboards.position), asc(dashboards.createdAt));

      const pendingIds = app.pendingConnectionIds ?? [];
      const pendingConnections = pendingIds.length
        ? await db
            .select({ id: dataConnections.id, name: dataConnections.name })
            .from(dataConnections)
            .where(and(eq(dataConnections.orgId, scope.orgId), inArray(dataConnections.id, pendingIds)))
            .orderBy(asc(dataConnections.name))
        : [];

      const badges = await connectionBadges([app.id]);
      const { pendingConnectionIds: _ids, ...rest } = app;
      return {
        ...rest,
        pendingConnections,
        dashboards: appDashboards,
        connections: badges.map(({ id, name, type, status, config }) => ({
          id,
          name,
          type,
          status,
          // Signed in with OAuth: when it's invalid, the fix is signing in again.
          signIn: config && typeof config === "object" && "oauth" in config && config.oauth ? ("oauth" as const) : null,
        })),
      };
    },

    /**
     * Creates an app from the prompt typed on the home page, with the data
     * sources picked in the composer. Every source must be the user's own.
     */
    create(scope: Scope, input: unknown): Promise<AppResult<{ id: string }>> {
      return guard("create", async () => {
        const parsed = createAppSchema.safeParse(input);
        if (!parsed.success) return fromValidation(parsed.error);
        const { prompt, connectionIds } = parsed.data;

        const owned = await db
          .select({ id: dataConnections.id, name: dataConnections.name })
          .from(dataConnections)
          .where(and(eq(dataConnections.orgId, scope.orgId), inArray(dataConnections.id, connectionIds)));
        if (owned.length !== connectionIds.length) {
          return fail({
            code: "validation",
            field: "connectionIds",
            message: "One of the chosen data sources no longer exists. Choose again.",
          });
        }

        // Named after its data sources, in the order they were picked; the user renames it.
        const sources = connectionIds.map((id) => owned.find((row) => row.id === id)!.name);
        const taken = await db.select({ name: apps.name }).from(apps).where(eq(apps.orgId, scope.orgId));
        const [app] = await db
          .insert(apps)
          .values({
            userId: scope.userId,
            orgId: scope.orgId,
            name: appName(sources, taken.map((row) => row.name)),
            pendingPrompt: prompt,
            pendingConnectionIds: connectionIds,
          })
          .returning({ id: apps.id });
        // The sources picked for it are the app's from the start: they show on it, and the agent is told about them.
        await db.insert(appConnections).values(connectionIds.map((connectionId) => ({ appId: app.id, connectionId }))).onConflictDoNothing();
        return ok({ id: app.id });
      });
    },

    rename(scope: Scope, input: unknown): Promise<AppResult> {
      return guard("rename", async () => {
        const parsed = renameAppSchema.safeParse(input);
        if (!parsed.success) return fromValidation(parsed.error);
        const updated = await db
          .update(apps)
          .set({ name: parsed.data.name, updatedAt: now() })
          .where(and(eq(apps.id, parsed.data.id), eq(apps.orgId, scope.orgId)))
          .returning({ id: apps.id });
        return updated.length ? ok(undefined) : notFound();
      });
    },

    /**
     * Deletes the app and, through the foreign keys, its dashboards, thread
     * mappings and connection usage. Deleting the Cloud dashboards and
     * conversations comes with the chat milestone.
     */
    remove(scope: Scope, input: unknown): Promise<AppResult> {
      return guard("remove", async () => {
        const parsed = appRefSchema.safeParse(input);
        if (!parsed.success) return notFound();
        if (!(await service.mayRemove(scope, parsed.data.id))) return notFound();
        const deleted = await db
          .delete(apps)
          .where(and(eq(apps.id, parsed.data.id), eq(apps.orgId, scope.orgId)))
          .returning({ id: apps.id });
        return deleted.length ? ok(undefined) : notFound();
      });
    },

    /** Whether the caller may delete the app: an admin, or the member who created it. */
    async mayRemove(scope: Scope, appId: string): Promise<boolean> {
      if (!appIdSchema.safeParse(appId).success) return false;
      if (scope.role === "viewer") return false;
      const [row] = await db
        .select({ userId: apps.userId })
        .from(apps)
        .where(and(eq(apps.id, appId), eq(apps.orgId, scope.orgId)))
        .limit(1);
      if (!row) return false;
      return !scope.role || hasRole(scope.role, "admin") || row.userId === scope.userId;
    },

    /**
     * Returns the pending prompt and its data sources, clearing both in one
     * statement, so the chat sends them as the first message exactly once.
     * For the chat milestone.
     */
    async takePendingPrompt(
      scope: Scope,
      appId: string,
    ): Promise<{ prompt: string; connectionIds: string[] } | null> {
      if (!appIdSchema.safeParse(appId).success) return null;
      const result = await db.execute<{
        pending_prompt: string | null;
        pending_connection_ids: string[] | null;
      }>(sql`
        UPDATE ${apps} SET pending_prompt = NULL, pending_connection_ids = NULL
        FROM (
          SELECT id, pending_prompt, pending_connection_ids FROM ${apps}
          WHERE id = ${appId} AND org_id = ${scope.orgId} AND user_id = ${scope.userId}
          FOR UPDATE
        ) AS previous
        WHERE ${apps.id} = previous.id
        RETURNING previous.pending_prompt, previous.pending_connection_ids
      `);
      const row = result.rows[0];
      if (!row?.pending_prompt) return null;
      return { prompt: row.pending_prompt, connectionIds: row.pending_connection_ids ?? [] };
    },

    /** Adds one of the user's connections to an app, so it shows there and the agent uses it. */
    addConnection(scope: Scope, input: unknown): Promise<AppResult> {
      const parsed = addAppConnectionSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(notFound());
      return service.recordConnectionUse(scope, parsed.data.appId, parsed.data.connectionId);
    },

    /**
     * Records that an app's dashboards use a connection. Both must belong to
     * the user. The server calls it when a dashboard queries a connection;
     * the browser never can. For the chat milestone.
     */
    recordConnectionUse(scope: Scope, appId: string, connectionId: string): Promise<AppResult> {
      return guard("recordConnectionUse", async () => {
        if (!appIdSchema.safeParse(appId).success || !appIdSchema.safeParse(connectionId).success) {
          return notFound();
        }
        const [connection] = await db
          .select({ id: dataConnections.id })
          .from(dataConnections)
          .where(and(eq(dataConnections.id, connectionId), eq(dataConnections.orgId, scope.orgId)))
          .limit(1);
        if (!connection || !(await owns(scope, appId))) return notFound();

        await db.insert(appConnections).values({ appId, connectionId }).onConflictDoNothing();
        return ok(undefined);
      });
    },
  };
  return service;
}

export type AppService = ReturnType<typeof createAppService>;

/**
 * A new app's name: its data sources and a number, "Retail sales: App 2",
 * one more than the highest already used for those sources. No model is
 * involved; the user renames it whenever they like.
 */
export function appName(sources: string[], taken: string[]): string {
  let prefix =
    sources.length === 0
      ? "Untitled"
      : sources.length <= 2
        ? sources.join(" + ")
        : `${sources[0]} + ${sources.length - 1} more`;
  if (prefix.length > 60) prefix = `${prefix.slice(0, 59).trimEnd()}…`;

  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: App (\\d+)$`);
  const highest = Math.max(0, ...taken.map((name) => Number(pattern.exec(name)?.[1] ?? 0)));
  return `${prefix}: App ${highest + 1}`;
}
