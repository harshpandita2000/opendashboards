import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAppService } from "@/lib/apps/service";
import { createThreadService } from "@/lib/apps/threads";
import { createConnectionService } from "@/lib/connections/service";
import { createDashboardService } from "@/lib/dashboards/service";
import { createDatabase } from "@/lib/db";
import { apps, dataConnections, type AppTeamAccess, type OrgRole } from "@/lib/db/schema";
import { accessFor, appAccess, canChange } from "@/lib/orgs/access";
import { plaintextSecretBox } from "@/lib/secrets/plaintext";
import { posthogSource } from "@/lib/sources/posthog/source";
import type { ConnectionSource } from "@/lib/sources/types";

import { TEST_DATABASE_URL } from "./global-setup";
import { workspaceOf, seedWorkspaces, seedTeam } from "./orgs";

const { db, pool } = createDatabase(TEST_DATABASE_URL);
const appsService = createAppService({ db });
const threads = createThreadService({ db });
const dashboards = createDashboardService({ db });
const connections = createConnectionService({
  db,
  secrets: () => plaintextSecretBox,
  sources: () => ({ ...posthogSource, test: async () => [] }) as unknown as ConnectionSource,
});

const KEYED = { type: "posthog", name: "Production", hostKind: "posthog_us", projectId: "1", apiKey: "phx_abcdefghijklmnopqrstuvwxyz1234" };

/** Acme: Alice is its admin, Ed an editor, Vera a viewer. Mallory is in no team with them. */
let acme: string;
const inAcme = (userId: string) => ({ userId, orgId: acme });

async function keyed(userId: string, name = "Production") {
  const result = await connections.create(inAcme(userId), { ...KEYED, name });
  if (!result.ok) throw new Error(result.error.code);
  return result.data.id;
}

/** A sign-in (OAuth) connection of `userId`'s in Acme, personal unless said otherwise. */
async function signedIn(userId: string, sharing: "personal" | "org" = "personal") {
  const [row] = await db
    .insert(dataConnections)
    .values({
      id: randomUUID(),
      userId,
      orgId: acme,
      sharing,
      name: "Linear",
      type: "mcp",
      config: {
        type: "mcp",
        url: "https://mcp.linear.app/mcp",
        headerName: "Authorization",
        oauth: { issuer: "https://mcp.linear.app", tokenEndpoint: "https://mcp.linear.app/token", resource: "https://mcp.linear.app/mcp" },
      },
      secret: { v: 1, provider: "plaintext", value: "{}" },
      credentialHint: "signed in",
      status: "ok",
      lastCheckedAt: new Date(),
    })
    .returning({ id: dataConnections.id });
  return row.id;
}

async function app(userId: string, teamAccess: AppTeamAccess = "private") {
  const connectionId = await keyed("alice", `Source ${randomUUID().slice(0, 8)}`);
  const result = await appsService.create(inAcme(userId), { prompt: "Signups", connectionIds: [connectionId] });
  if (!result.ok) throw new Error(result.error.code);
  await db.update(apps).set({ teamAccess }).where(eq(apps.id, result.data.id));
  return { appId: result.data.id, connectionId };
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${apps}, ${dataConnections} CASCADE`);
  await seedWorkspaces(db, ["alice", "ed", "vera", "mallory"]);
  acme = await seedTeam(db, "Acme", { alice: "admin", ed: "editor", vera: "viewer" });
});

afterAll(() => pool.end());

describe("access to an app", () => {
  const roles: OrgRole[] = ["admin", "editor", "viewer"];

  it("is the lower of the member's role and what the app grants the team", () => {
    const of = (teamAccess: AppTeamAccess) => roles.map((role) => accessFor({ userId: "owner", teamAccess }, "someone", role));
    expect(of("private")).toEqual([null, null, null]);
    expect(of("view")).toEqual(["view", "view", "view"]);
    expect(of("edit")).toEqual(["edit", "edit", "view"]);
  });

  it("is full for the owner, though a viewer still can't build", () => {
    expect(roles.map((role) => accessFor({ userId: "owner", teamAccess: "private" }, "owner", role))).toEqual(["owner", "owner", "owner"]);
    expect(roles.map((role) => canChange("owner", role))).toEqual([true, true, false]);
    expect(canChange("view", "admin")).toBe(false);
  });

  it("keeps a private app from everyone else, the team's admin included", async () => {
    const { appId } = await app("ed");
    expect(await appAccess(db, "ed", appId)).toMatchObject({ access: "owner", canChange: true });
    for (const other of ["alice", "vera", "mallory"]) {
      expect(await appAccess(db, other, appId)).toBeNull();
      expect(await appsService.get(other, appId)).toBeNull();
      expect(await dashboards.list(other, appId)).toEqual([]);
    }
    expect((await appsService.list(inAcme("alice"))).map((row) => row.id)).not.toContain(appId);
  });

  it("lets the team open an app shared for viewing, and change nothing", async () => {
    const { appId } = await app("ed", "view");
    await dashboards.record("ed", appId, { artifactId: "art_1", title: "Signups" });

    for (const member of ["alice", "vera"]) {
      expect(await appsService.get(member, appId)).toMatchObject({ access: "view", canChange: false });
      expect((await dashboards.list(member, appId)).map((row) => row.title)).toEqual(["Signups"]);
      expect(await dashboards.findByArtifact(member, "art_1")).toMatchObject({ appId });
      expect(await appsService.rename(member, { id: appId, name: "Mine" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await dashboards.record(member, appId, { artifactId: "art_2", title: "Extra" })).toBeNull();
      expect(await dashboards.update(member, appId, "00000000-0000-4000-8000-000000000000", { title: "x" })).toBe(false);
      expect(await threads.register(member, appId, { threadId: "thread_1", title: "Hi" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    expect((await appsService.list(inAcme("vera"))).map((row) => ({ id: row.id, mine: row.mine }))).toEqual([{ id: appId, mine: false }]);
    expect(await appAccess(db, "mallory", appId)).toBeNull();
  });

  it("lets editors and admins change an app shared for editing, but a viewer only view it", async () => {
    const { appId } = await app("ed", "edit");
    expect(await appsService.get("alice", appId)).toMatchObject({ access: "edit", canChange: true });
    expect(await appsService.rename("alice", { id: appId, name: "Renamed" })).toEqual({ ok: true, data: undefined });
    expect(await dashboards.record("alice", appId, { artifactId: "art_1", title: "By Alice" })).not.toBeNull();
    expect(await threads.register("alice", appId, { threadId: "thread_a", title: "Hi" })).toMatchObject({ ok: true });

    expect(await appsService.get("vera", appId)).toMatchObject({ access: "view", canChange: false });
    expect(await threads.register("vera", appId, { threadId: "thread_v", title: "Hi" })).toMatchObject({ ok: false });
  });

  it("only lets the owner delete an app", async () => {
    const { appId } = await app("ed", "edit");
    expect(await appsService.remove("alice", { id: appId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await appsService.remove("ed", { id: appId })).toEqual({ ok: true, data: undefined });
  });

  it("keeps each member's chats their own, even in a shared app", async () => {
    const { appId } = await app("ed", "edit");
    await threads.register("ed", appId, { threadId: "thread_ed", title: "Ed's" });
    await threads.register("alice", appId, { threadId: "thread_alice", title: "Alice's" });
    const list = await threads.list("alice", appId);
    expect(list.ok && list.data.threads.map((thread) => thread.id)).toEqual(["thread_alice"]);
    expect(await threads.belongsTo("alice", appId, "thread_ed")).toBe(false);
  });

  it("ends when the member leaves the team", async () => {
    const { appId } = await app("ed", "edit");
    await seedTeam(db, "Acme", { alice: "admin", vera: "viewer" });
    await db.execute(sql`DELETE FROM org_members WHERE org_id = ${acme} AND user_id = 'ed'`);
    expect(await appAccess(db, "ed", appId)).toBeNull();
  });
});

describe("a viewer", () => {
  it("can't create an app or a connection, or install a demo", async () => {
    const connectionId = await keyed("alice");
    expect(await appsService.create(inAcme("vera"), { prompt: "Signups", connectionIds: [connectionId] })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await connections.create(inAcme("vera"), KEYED)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await connections.installDemo(inAcme("vera"), { dataset: "retail" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("can use the team's connections but not change them", async () => {
    const connectionId = await keyed("alice");
    expect((await connections.list(inAcme("vera"))).map(({ id, canManage }) => ({ id, canManage }))).toEqual([{ id: connectionId, canManage: false }]);
    expect(await connections.rename("vera", { id: connectionId, name: "Mine" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await connections.remove("vera", { id: connectionId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await connections.replaceCredential("vera", { id: connectionId, credential: KEYED.apiKey })).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });
});

describe("connections in a team", () => {
  it("serve every member when they have a key, and any editor can manage them", async () => {
    const connectionId = await keyed("alice");
    for (const member of ["alice", "ed", "vera"]) {
      expect(await connections.open(member, connectionId, "posthog")).toMatchObject({ id: connectionId, credential: KEYED.apiKey });
    }
    expect((await connections.list(inAcme("ed")))[0]).toMatchObject({ sharing: "org", mine: false, addedBy: "alice@example.com", canManage: true });
    expect(await connections.rename("ed", { id: connectionId, name: "Prod" })).toEqual({ ok: true, data: undefined });
    // Re-keyed by someone else: still sealed for whoever added it, and still opens for everyone.
    expect(await connections.replaceCredential("ed", { id: connectionId, credential: "phx_zyxwvutsrqponmlkjihgfedcba4321" })).toMatchObject({ ok: true });
    expect(await connections.open("vera", connectionId, "posthog")).toMatchObject({ credential: "phx_zyxwvutsrqponmlkjihgfedcba4321" });
    expect(await connections.remove("ed", { id: connectionId })).toEqual({ ok: true, data: undefined });
  });

  it("are out of reach of anyone outside the team", async () => {
    const connectionId = await keyed("alice");
    expect(await connections.open("mallory", connectionId, "posthog")).toBeNull();
    expect(await connections.rename("mallory", { id: connectionId, name: "Mine" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await connections.list(workspaceOf("mallory"))).toEqual([]);
    // Naming the team doesn't help: membership is read from the database.
    expect(await connections.list(inAcme("mallory"))).toEqual([]);
    expect(await connections.create(inAcme("mallory"), KEYED)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("never open from another org's app, even for someone in both", async () => {
    const connectionId = await keyed("alice");
    expect(await connections.open("alice", connectionId, "posthog", { orgId: workspaceOf("alice").orgId })).toBeNull();
    expect(await connections.open("alice", connectionId, "posthog", { orgId: acme })).not.toBeNull();
  });

  it("keep a sign-in to whoever signed in, the team's admin included", async () => {
    const connectionId = await signedIn("ed");
    expect(await connections.open("ed", connectionId, "mcp")).not.toBeNull();
    for (const other of ["alice", "vera", "mallory"]) {
      expect(await connections.open(other, connectionId, "mcp")).toBeNull();
      expect(await connections.remove(other, { id: connectionId })).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    expect((await connections.list(inAcme("alice"))).map((row) => row.id)).not.toContain(connectionId);
    expect((await connections.list(inAcme("ed"))).find((row) => row.id === connectionId)).toMatchObject({ sharing: "personal", mine: true });
  });

  it("let only whoever signed in share a sign-in, after which everyone queries with it", async () => {
    const connectionId = await signedIn("ed");
    expect(await connections.setSharing("alice", { id: connectionId, sharing: "org" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await connections.setSharing("ed", { id: connectionId, sharing: "org" })).toEqual({ ok: true, data: undefined });

    expect(await connections.open("vera", connectionId, "mcp")).not.toBeNull();
    expect((await connections.list(inAcme("alice"))).find((row) => row.id === connectionId)).toMatchObject({
      sharing: "org",
      mine: false,
      addedBy: "ed@example.com",
    });
    // Shared, but still Ed's: nobody else takes it back or signs in to it again.
    expect(await connections.setSharing("alice", { id: connectionId, sharing: "personal" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(
      await connections.startSignIn(inAcme("alice"), {
        stateHash: "a".repeat(64),
        connectionId,
        name: "Linear",
        config: { type: "mcp", url: "https://mcp.linear.app/mcp", headerName: "Authorization" },
        pending: "{}",
      }),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });

    expect(await connections.setSharing("ed", { id: connectionId, sharing: "personal" })).toEqual({ ok: true, data: undefined });
    expect(await connections.open("vera", connectionId, "mcp")).toBeNull();
  });

  it("never make a key personal", async () => {
    const connectionId = await keyed("ed");
    expect(await connections.setSharing("ed", { id: connectionId, sharing: "personal" })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("can't be deleted while another member's private app uses them, without naming that app", async () => {
    const { connectionId } = await app("ed");
    const result = await connections.remove("alice", { id: connectionId });
    expect(result).toMatchObject({ ok: false, error: { code: "in_use", apps: [] } });
    expect(result.ok ? "" : result.error.message).toContain("another member's app");
  });

  it("only join an app of the same org, by someone who can change it", async () => {
    const { appId } = await app("ed", "view");
    const extra = await keyed("alice", "Extra");
    expect(await appsService.addConnection("vera", { appId, connectionId: extra })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await appsService.addConnection("ed", { appId, connectionId: extra })).toEqual({ ok: true, data: undefined });

    await seedWorkspaces(db, ["ed"]);
    const own = await connections.create(workspaceOf("ed"), KEYED);
    expect(own.ok && (await appsService.addConnection("ed", { appId, connectionId: own.data.id }))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});
