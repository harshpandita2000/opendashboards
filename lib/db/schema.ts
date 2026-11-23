import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { ConnectionConfig } from "@/lib/sources/catalog";
import type { SealedSecret } from "@/lib/secrets/types";
import type { ModelProviderConfig } from "@/lib/models/config";
import type { OrgSettings } from "@/lib/orgs/settings";

/** Matches CONNECTION_TYPES in lib/sources/catalog.ts (a test checks). */
export const connectionTypeEnum = pgEnum("connection_type", ["posthog", "postgres", "mysql", "clickhouse", "bigquery", "ga4", "searchconsole", "mcp"]);

export const connectionStatusEnum = pgEnum("connection_status", [
  /** The last check passed. */
  "ok",
  /** The credential or settings are wrong: the user has to fix them. */
  "invalid",
  /** We couldn't check (source or secret storage unavailable): retry later. */
  "unavailable",
]);

/** What a member may do in an organisation. Ordered: each role can do everything the next one can. */
export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member", "viewer"]);

/**
 * An organisation (tenant). Everything a team shares (connections, apps,
 * dashboards, threads, model providers) belongs to one, and every query is
 * scoped to it. Signing up creates a personal one.
 */
export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Set on a user's personal organisation, created for them on first sign-in. */
    personalFor: text("personal_for"),
    /**
     * Who owns this organisation's artifacts and conversations in OpenUI Cloud
     * (its frontend tokens and dashboards are per "user"). A personal org
     * migrated from before organisations keeps its user's id, so existing
     * dashboards stay readable; new orgs get "org_<id>".
     */
    openuiUserId: text("openui_user_id").notNull().unique(),
    /** Organisation-wide policies (MCP host allow-list, …). See lib/orgs/settings.ts. */
    settings: jsonb("settings").$type<OrgSettings>().notNull().default({}),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("orgs_personal_for_idx").on(table.personalFor)],
);

/** Who belongs to an organisation, and as what. */
export const orgMembers = pgTable(
  "org_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** The member's sign-in email when they joined, for the members list. Never used to authorize. */
    email: text("email").notNull(),
    role: orgRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.userId] }), index("org_members_user_id_idx").on(table.userId)],
);

/**
 * An invitation to join an organisation. The link carries a random token;
 * only its SHA-256 is stored. Accepting needs a signed-in user whose email
 * matches, before it expires, once.
 */
export const orgInvites = pgTable(
  "org_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Lower-cased. */
    email: text("email").notNull(),
    role: orgRoleEnum("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("org_invites_org_id_idx").on(table.orgId),
    // One open invitation per address per organisation.
    uniqueIndex("org_invites_open_idx").on(table.orgId, table.email).where(sql`${table.acceptedAt} IS NULL`),
    check("org_invites_not_owner", sql`${table.role} <> 'owner'`),
  ],
);

export const modelProviderKindEnum = pgEnum("model_provider_kind", ["azure_openai"]);

/**
 * A model endpoint an organisation brings: today Azure OpenAI. The default
 * one runs the Build agent instead of OpenUI Gateway. Where it points is in
 * `config`; the API key or client secret is sealed in `secret`.
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: modelProviderKindEnum("kind").notNull(),
    config: jsonb("config").$type<ModelProviderConfig>().notNull(),
    secret: jsonb("secret").$type<SealedSecret>().notNull(),
    credentialHint: text("credential_hint").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    status: connectionStatusEnum("status").notNull(),
    /** The last test's failure, for the settings page. Never contains the credential. */
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_providers_org_id_idx").on(table.orgId),
    // At most one default per organisation.
    uniqueIndex("model_providers_default_idx").on(table.orgId).where(sql`${table.isDefault}`),
  ],
);

export const dataConnections = pgTable(
  "data_connections",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Who created it. Its secret is sealed for this user and connection (and, since organisations, the org). */
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    type: connectionTypeEnum("type").notNull(),
    /**
     * Where the connection points, per type (PostHog region and project;
     * Postgres host, port, database, user, SSL mode). Validated on every read.
     * Fixed after creation: pointing elsewhere means a new connection.
     */
    config: jsonb("config").$type<ConnectionConfig>().notNull(),
    /** The API key or password, sealed by a SecretBox. Never sent to the browser. Null for a demo dataset. */
    secret: jsonb("secret").$type<SealedSecret>(),
    /** e.g. "phx_…a1b2", so the UI never needs the credential itself. */
    credentialHint: text("credential_hint").notNull(),
    /**
     * Set when this is an installed demo dataset: its key in config's
     * demoData. Where it points and its (shared, read-only) credential
     * then come from config, never from this row, so it has no secret.
     */
    demoDataset: text("demo_dataset"),
    status: connectionStatusEnum("status").notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("data_connections_user_id_idx").on(table.userId),
    index("data_connections_org_id_idx").on(table.orgId),
    // Each demo dataset is installed at most once per organisation.
    uniqueIndex("data_connections_org_demo_idx").on(table.orgId, table.demoDataset),
    // A demo dataset has no secret of its own; every other connection has one.
    check("data_connections_secret_or_demo", sql`(${table.demoDataset} IS NULL) = (${table.secret} IS NOT NULL)`),
  ],
);

/**
 * An app: a set of dashboards built by chatting. It can query any of its
 * owner's connections; `app_connections` records the ones it actually uses.
 */
export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Who created it. */
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    /** The prompt the app was created with, until the chat sends it as the first message. */
    pendingPrompt: text("pending_prompt"),
    /**
     * The data sources picked in the composer for that first message: a hint
     * for the agent, checked to be the user's own. What the app actually uses
     * is still recorded in `app_connections` as dashboards query them.
     */
    pendingConnectionIds: uuid("pending_connection_ids").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("apps_user_id_idx").on(table.userId, table.updatedAt), index("apps_org_id_idx").on(table.orgId, table.updatedAt)],
);

/**
 * Which connections an app uses, recorded by the server when a dashboard
 * queries one. Never chosen by the browser. A connection with rows here
 * can't be deleted.
 */
export const appConnections = pgTable(
  "app_connections",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => dataConnections.id, { onDelete: "restrict" }),
    firstUsedAt: timestamp("first_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.connectionId] }),
    index("app_connections_connection_id_idx").on(table.connectionId),
  ],
);

/** A dashboard in an app. Its content and versions live in OpenUI Cloud. */
export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Who created it. */
    userId: text("user_id").notNull(),
    /** OpenUI Cloud's artifact id (art_…). */
    artifactId: text("artifact_id").notNull().unique(),
    /**
     * The dashboard's title and one-line description, drawn above it. OpenDashboards
     * keeps them, not the program in Cloud: the agent sets them when it
     * creates the dashboard, and only people change them afterwards.
     */
    title: text("title").notNull(),
    description: text("description"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("dashboards_app_id_idx").on(table.appId, table.position), index("dashboards_org_id_idx").on(table.orgId)],
);

/**
 * Which app each chat thread belongs to. Threads live in OpenUI Cloud, which
 * has no notion of apps, so the app's thread list is read from here.
 */
export const appThreads = pgTable(
  "app_threads",
  {
    /** OpenUI Cloud's conversation id. */
    threadId: text("thread_id").primaryKey(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Who started it. */
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    // Millisecond precision: the list's paging cursor round-trips through JS Dates.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => [index("app_threads_app_id_idx").on(table.appId, table.updatedAt)],
);

/**
 * An MCP OAuth sign-in that's been started and not yet finished: kept from
 * sending the browser to the server's sign-in page until it comes back. The
 * key is a hash of the `state` sent with it, so a database read can't replay
 * one. Single use, short-lived, and tied to the user who started it.
 */
export const mcpOAuthSignIns = pgTable(
  "mcp_oauth_sign_ins",
  {
    /** SHA-256 of the state, hex. */
    stateHash: text("state_hash").primaryKey(),
    userId: text("user_id").notNull(),
    /** The organisation the connection will belong to. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),

    /** Set when signing in again to an existing connection. */
    connectionId: uuid("connection_id").references(() => dataConnections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The connection's settings once signed in: the server and its authorization server, nothing secret. */
    config: jsonb("config").notNull(),
    /** The PKCE verifier and client registration, sealed like any credential. */
    secret: jsonb("secret").$type<SealedSecret>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mcp_oauth_sign_ins_user_id_idx").on(table.userId)],
);

export type DataConnectionRow = typeof dataConnections.$inferSelect;
export type OrgRow = typeof orgs.$inferSelect;
export type OrgRole = (typeof orgRoleEnum.enumValues)[number];
export type ModelProviderRow = typeof modelProviders.$inferSelect;
export type ConnectionStatus = (typeof connectionStatusEnum.enumValues)[number];
