import { and, asc, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import {
  appConnections,
  apps,
  dashboards,
  dataConnections,
  type AppTeamAccess,
  type ConnectionStatus,
} from "@/lib/db/schema";
import type { ConnectionType } from "@/lib/sources/catalog";
import { logError } from "@/lib/log";
import { appAccess, canBuild, roleIn, type AppAccess, type Scope } from "@/lib/orgs/access";

import { fail, forbidden, fromValidation, internalError, notFound, ok, type AppResult } from "./errors";
import { addAppConnectionSchema, appIdSchema, appRefSchema, createAppSchema, renameAppSchema } from "./schemas";

export type AppConnectionBadge = { id: string; name: string };

export type AppSummary = {
  id: string;
  name: string;
  updatedAt: Date;
  dashboardCount: number;
  connections: AppConnectionBadge[];
  /** Whether the caller owns it; otherwise it was shared with their team. */
  mine: boolean;
};

export type AppTreeNode = { id: string; name: string; dashboards: { id: string; title: string }[] };

export type AppDetail = {
  id: string;
  name: string;
  /** The org it belongs to. */
  orgId: string;
  /** What the caller may do with it. */
  access: AppAccess;
  /** Whether the caller may build in it: chat, rename, change its dashboards. Never true for a viewer. */
  canChange: boolean;
  teamAccess: AppTeamAccess;
  pendingPrompt: string | null;
  /** The data sources picked for the pending prompt, by name. */
  pendingConnections: AppConnectionBadge[];
  createdAt: Date;
  updatedAt: Date;
  dashboards: { id: string; title: string; description: string | null; artifactId: string; position: number }[];
  connections: (AppConnectionBadge & { type: ConnectionType; status: ConnectionStatus; signIn: "oauth" | null })[];
};

/**
 * The data access layer for apps. An app belongs to an org and has an owner.
 * Who may see or change it is decided by lib/orgs/access, from the database:
 * an app the caller can't open looks exactly like a missing one.
 */
export function createAppService({ db, now = () => new Date() }: { db: Database; now?: () => Date }) {
  async function guard<T>(operation: string, fn: () => Promise<AppResult<T>>): Promise<AppResult<T>> {
    try {
      return await fn();
    } catch (error) {
      logError(`apps.${operation}`, error);
      return internalError();
    }
  }

  /** The apps of an org this member can open: their own, and the ones shared with the team. */
  const visibleTo = ({ userId, orgId }: Scope) =>
    and(eq(apps.orgId, orgId), or(eq(apps.userId, userId), ne(apps.teamAccess, "private")));

  /** The connections of an org this member can query: the org's, and their own sign-ins. */
  const usableBy = ({ userId, orgId }: Scope) =>
    and(eq(dataConnections.orgId, orgId), or(eq(dataConnections.sharing, "org"), eq(dataConnections.userId, userId)));

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
    /** The apps in the org the member can open, most recently updated first. */
    async list(scope: Scope, { limit }: { limit?: number } = {}): Promise<AppSummary[]> {
      if (!(await roleIn(db, scope.userId, scope.orgId))) return [];
      const query = db
        .select({
          id: apps.id,
          name: apps.name,
          updatedAt: apps.updatedAt,
          ownerId: apps.userId,
          dashboardCount: count(dashboards.id),
        })
        .from(apps)
        .leftJoin(dashboards, eq(dashboards.appId, apps.id))
        .where(visibleTo(scope))
        .groupBy(apps.id)
        .orderBy(desc(apps.updatedAt), desc(apps.id));
      const rows = limit ? await query.limit(limit) : await query;

      const badges = await connectionBadges(rows.map((row) => row.id));
      return rows.map(({ ownerId, ...row }) => ({
        ...row,
        mine: ownerId === scope.userId,
        connections: badges
          .filter((badge) => badge.appId === row.id)
          .map(({ id, name }) => ({ id, name })),
      }));
    },

    /** Apps with their dashboards' titles, for the sidebar tree. Newest app first. */
    async tree(scope: Scope): Promise<AppTreeNode[]> {
      if (!(await roleIn(db, scope.userId, scope.orgId))) return [];
      const appRows = await db
        .select({ id: apps.id, name: apps.name })
        .from(apps)
        .where(visibleTo(scope))
        .orderBy(desc(apps.updatedAt), desc(apps.id));
      if (!appRows.length) return [];

      const dashboardRows = await db
        .select({ appId: dashboards.appId, id: dashboards.id, title: dashboards.title })
        .from(dashboards)
        .where(
          inArray(
            dashboards.appId,
            appRows.map((app) => app.id),
          ),
        )
        .orderBy(asc(dashboards.position), asc(dashboards.createdAt));

      return appRows.map((app) => ({
        ...app,
        dashboards: dashboardRows
          .filter((dashboard) => dashboard.appId === app.id)
          .map(({ id, title }) => ({ id, title })),
      }));
    },

    async get(userId: string, appId: string): Promise<AppDetail | null> {
      const grant = await appAccess(db, userId, appId);
      if (!grant) return null;
      const [app] = await db
        .select({
          id: apps.id,
          name: apps.name,
          teamAccess: apps.teamAccess,
          pendingPrompt: apps.pendingPrompt,
          pendingConnectionIds: apps.pendingConnectionIds,
          createdAt: apps.createdAt,
          updatedAt: apps.updatedAt,
        })
        .from(apps)
        .where(eq(apps.id, appId))
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
            .where(and(usableBy({ userId, orgId: grant.orgId }), inArray(dataConnections.id, pendingIds)))
            .orderBy(asc(dataConnections.name))
        : [];

      const badges = await connectionBadges([app.id]);
      const { pendingConnectionIds: _ids, ...rest } = app;
      return {
        ...rest,
        orgId: grant.orgId,
        access: grant.access,
        canChange: grant.canChange,
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
     * Creates an app in the org from the prompt typed on the home page, with
     * the data sources picked in the composer. The caller owns it, and it
     * starts private. Every source must be one they can query in that org.
     */
    create(scope: Scope, input: unknown): Promise<AppResult<{ id: string }>> {
      return guard("create", async () => {
        const role = await roleIn(db, scope.userId, scope.orgId);
        if (!role) return notFound();
        if (!canBuild(role)) return forbidden();
        const parsed = createAppSchema.safeParse(input);
        if (!parsed.success) return fromValidation(parsed.error);
        const { prompt, connectionIds } = parsed.data;

        const usable = await db
          .select({ id: dataConnections.id, name: dataConnections.name })
          .from(dataConnections)
          .where(and(usableBy(scope), inArray(dataConnections.id, connectionIds)));
        if (usable.length !== connectionIds.length) {
          return fail({
            code: "validation",
            field: "connectionIds",
            message: "One of the chosen data sources no longer exists. Choose again.",
          });
        }

        // Named after its data sources, in the order they were picked; the user renames it.
        const sources = connectionIds.map((id) => usable.find((row) => row.id === id)!.name);
        const taken = await db
          .select({ name: apps.name })
          .from(apps)
          .where(and(eq(apps.orgId, scope.orgId), eq(apps.userId, scope.userId)));
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

    rename(userId: string, input: unknown): Promise<AppResult> {
      return guard("rename", async () => {
        const parsed = renameAppSchema.safeParse(input);
        if (!parsed.success) return fromValidation(parsed.error);
        const grant = await appAccess(db, userId, parsed.data.id);
        if (!grant) return notFound();
        if (!grant.canChange) return forbidden();
        const updated = await db
          .update(apps)
          .set({ name: parsed.data.name, updatedAt: now() })
          .where(eq(apps.id, parsed.data.id))
          .returning({ id: apps.id });
        return updated.length ? ok(undefined) : notFound();
      });
    },

    /**
     * Deletes the app and, through the foreign keys, its dashboards, thread
     * mappings and connection usage. Only its owner can. The caller deletes
     * its dashboards in OpenUI Cloud first.
     */
    remove(userId: string, input: unknown): Promise<AppResult> {
      return guard("remove", async () => {
        const parsed = appRefSchema.safeParse(input);
        if (!parsed.success) return notFound();
        const grant = await appAccess(db, userId, parsed.data.id);
        if (!grant) return notFound();
        if (grant.access !== "owner") return forbidden("Only the app's owner can delete it.");
        const deleted = await db.delete(apps).where(eq(apps.id, parsed.data.id)).returning({ id: apps.id });
        return deleted.length ? ok(undefined) : notFound();
      });
    },

    /**
     * Returns the pending prompt and its data sources, clearing both in one
     * statement, so the chat sends them as the first message exactly once.
     * Only for the owner, who typed it.
     */
    async takePendingPrompt(
      userId: string,
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
          WHERE id = ${appId} AND user_id = ${userId}
          FOR UPDATE
        ) AS previous
        WHERE ${apps.id} = previous.id
        RETURNING previous.pending_prompt, previous.pending_connection_ids
      `);
      const row = result.rows[0];
      if (!row?.pending_prompt) return null;
      return { prompt: row.pending_prompt, connectionIds: row.pending_connection_ids ?? [] };
    },

    /** Adds a connection the caller can query to an app, so it shows there and the agent uses it. */
    addConnection(userId: string, input: unknown): Promise<AppResult> {
      const parsed = addAppConnectionSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(notFound());
      return service.recordConnectionUse(userId, parsed.data.appId, parsed.data.connectionId);
    },

    /**
     * Records that an app's dashboards use a connection. The caller must be
     * able to change the app and to query the connection, and both must be in
     * the same org. The server calls it when the Build agent queries a
     * connection; the browser never can.
     */
    recordConnectionUse(userId: string, appId: string, connectionId: string): Promise<AppResult> {
      return guard("recordConnectionUse", async () => {
        if (!appIdSchema.safeParse(appId).success || !appIdSchema.safeParse(connectionId).success) {
          return notFound();
        }
        const grant = await appAccess(db, userId, appId);
        if (!grant?.canChange) return notFound();
        const [connection] = await db
          .select({ id: dataConnections.id })
          .from(dataConnections)
          .where(and(eq(dataConnections.id, connectionId), usableBy({ userId, orgId: grant.orgId })))
          .limit(1);
        if (!connection) return notFound();

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
