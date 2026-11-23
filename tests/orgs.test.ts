import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAppService } from "@/lib/apps/service";
import { createThreadService } from "@/lib/apps/threads";
import { createConnectionService } from "@/lib/connections/service";
import { createDashboardService } from "@/lib/dashboards/service";
import { createDatabase } from "@/lib/db";
import { apps, dataConnections, orgInvites, orgMembers, orgs } from "@/lib/db/schema";
import { createOrgService, hashInviteToken, type OrgActor } from "@/lib/orgs/service";
import type { Scope } from "@/lib/orgs/scope";
import { createAesGcmSecretBox, parseAesKeys } from "@/lib/secrets/aes-gcm";
import { SecretUnreadableError } from "@/lib/secrets/types";
import { mcpSource } from "@/lib/sources/mcp/source";
import { posthogSource } from "@/lib/sources/posthog/source";
import type { ConnectionSource } from "@/lib/sources/types";

import { TEST_DATABASE_URL } from "./global-setup";

const { db, pool } = createDatabase(TEST_DATABASE_URL);
let clock = new Date("2026-11-23T10:00:00Z");
const orgService = createOrgService({ db, now: () => clock });
const secrets = createAesGcmSecretBox(parseAesKeys(randomBytes(32).toString("base64")));
const settingsByOrg = new Map<string, { mcpAllowedHosts?: string[] | null }>();
const connections = createConnectionService({
  db,
  secrets: () => secrets,
  sources: (type) => ({ ...(type === "mcp" ? mcpSource : posthogSource), test: async () => [] }) as unknown as ConnectionSource,
  orgSettings: async (orgId) => settingsByOrg.get(orgId) ?? {},
});
const appsService = createAppService({ db });
const threads = createThreadService({ db });
const dashboards = createDashboardService({ db });

const alice = { id: "alice", email: "alice@acme.test" };
const bob = { id: "bob", email: "Bob@Acme.test" };
const carol = { id: "carol", email: "carol@acme.test" };
const mallory = { id: "mallory", email: "mallory@evil.test" };

const posthog = (name = "Production") => ({
  type: "posthog",
  name,
  hostKind: "posthog_us",
  projectId: "1",
  apiKey: "phx_abcdefghijklmnopqrstuvwxyz1234",
});

async function teamOrg(owner: { id: string; email: string }, name = "Acme"): Promise<string> {
  const result = await orgService.create(owner, { name });
  if (!result.ok) throw new Error(result.error.code);
  return result.data.id;
}

async function join(orgId: string, inviter: OrgActor, user: { id: string; email: string }, role: "admin" | "member" | "viewer") {
  const invite = await orgService.invite(inviter, { email: user.email, role });
  if (!invite.ok) throw new Error(invite.error.code);
  const accepted = await orgService.accept(user, invite.data.token);
  if (!accepted.ok) throw new Error(accepted.error.code);
  return { orgId, userId: user.id, role } satisfies OrgActor;
}

beforeEach(async () => {
  clock = new Date("2026-11-23T10:00:00Z");
  settingsByOrg.clear();
  await db.execute(sql`TRUNCATE ${apps}, ${dataConnections}, ${orgs} CASCADE`);
});

afterAll(async () => {
  await pool.end();
});

describe("organisations", () => {
  it("gives every user one personal organisation, owned by them", async () => {
    const first = await orgService.ensurePersonal(alice);
    expect(await orgService.ensurePersonal(alice)).toBe(first);
    const [membership] = await orgService.memberships(alice.id);
    expect(membership).toMatchObject({ id: first, role: "owner", personal: true, cloudUserId: "alice" });
  });

  it("keeps the personal organisation's OpenUI identity as the user's id, so old dashboards stay readable", async () => {
    const [{ id }] = await db.execute<{ id: string }>(sql`select od_personal_org(${"legacy-user"}) as id`).then((r) => r.rows);
    expect(await orgService.ensurePersonal({ id: "legacy-user", email: "l@x.test" })).toBe(id);
    expect((await orgService.memberships("legacy-user"))[0]).toMatchObject({ cloudUserId: "legacy-user", personal: true });
  });

  it("gives a team organisation its own OpenUI identity", async () => {
    const orgId = await teamOrg(alice);
    const team = (await orgService.memberships(alice.id)).find((m) => m.id === orgId)!;
    expect(team).toMatchObject({ role: "owner", personal: false, cloudUserId: `org_${orgId}` });
  });
});

describe("invitations", () => {
  it("lets the invited address join once, with the invited role", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    const invite = await orgService.invite(owner, { email: "BOB@acme.test", role: "viewer" });
    if (!invite.ok) throw new Error(invite.error.code);
    // Only the hash is stored.
    const [row] = await db.select().from(orgInvites).where(eq(orgInvites.id, invite.data.id));
    expect(row.tokenHash).toBe(hashInviteToken(invite.data.token));
    expect(JSON.stringify(row)).not.toContain(invite.data.token);

    expect(await orgService.accept(mallory, invite.data.token)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await orgService.accept(bob, invite.data.token)).toEqual({ ok: true, data: { orgId } });
    expect(await orgService.roleOf(bob.id, orgId)).toBe("viewer");
    expect(await orgService.accept(bob, invite.data.token)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("expires", async () => {
    const orgId = await teamOrg(alice);
    const invite = await orgService.invite({ orgId, userId: alice.id, role: "owner" }, { email: bob.email, role: "member" });
    if (!invite.ok) throw new Error(invite.error.code);
    clock = new Date(clock.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(await orgService.accept(bob, invite.data.token)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("can be revoked, and re-inviting replaces the pending one", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    const first = await orgService.invite(owner, { email: bob.email, role: "member" });
    const second = await orgService.invite(owner, { email: bob.email, role: "admin" });
    if (!first.ok || !second.ok) throw new Error("invite failed");
    expect(await orgService.accept(bob, first.data.token)).toMatchObject({ ok: false });
    expect(await orgService.revokeInvite(owner, second.data.id)).toEqual({ ok: true, data: undefined });
    expect(await orgService.accept(bob, second.data.token)).toMatchObject({ ok: false });
  });

  it("only admins and owners invite, never as owner, and never into a personal organisation", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    const member = await join(orgId, owner, bob, "member");
    expect(await orgService.invite(member, { email: carol.email, role: "viewer" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await orgService.invite(owner, { email: carol.email, role: "owner" })).toMatchObject({ ok: false, error: { code: "validation" } });
    const personal = await orgService.ensurePersonal(alice);
    expect(await orgService.invite({ orgId: personal, userId: alice.id, role: "owner" }, { email: carol.email, role: "member" })).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
  });
});

describe("roles", () => {
  it("admins change roles and remove members; nobody touches the owner", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    const admin = await join(orgId, owner, bob, "admin");
    await join(orgId, owner, carol, "viewer");
    expect(await orgService.changeRole(admin, { userId: carol.id, role: "member" })).toEqual({ ok: true, data: undefined });
    expect(await orgService.roleOf(carol.id, orgId)).toBe("member");
    expect(await orgService.changeRole(admin, { userId: alice.id, role: "viewer" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await orgService.removeMember(admin, alice.id)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await orgService.removeMember(admin, carol.id)).toEqual({ ok: true, data: undefined });
    expect(await orgService.roleOf(carol.id, orgId)).toBeNull();
  });

  it("members can leave but not remove others", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    const member = await join(orgId, owner, bob, "member");
    await join(orgId, owner, carol, "member");
    expect(await orgService.removeMember(member, carol.id)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await orgService.removeMember(member, bob.id)).toEqual({ ok: true, data: undefined });
  });

  it("only the owner deletes a team organisation, and personal ones stay", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    const admin = await join(orgId, owner, bob, "admin");
    expect(await orgService.remove(admin)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const personal = await orgService.ensurePersonal(alice);
    expect(await orgService.remove({ orgId: personal, userId: alice.id, role: "owner" })).toMatchObject({ ok: false });
    expect(await orgService.remove(owner)).toEqual({ ok: true, data: undefined });
    expect(await db.select().from(orgMembers).where(eq(orgMembers.orgId, orgId))).toEqual([]);
  });
});

describe("tenancy isolation", () => {
  async function twoOrgs() {
    const a = await teamOrg(alice, "A");
    const b = await teamOrg(mallory, "B");
    return {
      a: { orgId: a, userId: alice.id, role: "owner" } as Scope,
      b: { orgId: b, userId: mallory.id, role: "owner" } as Scope,
    };
  }

  it("keeps connections, apps, dashboards and threads inside their organisation", async () => {
    const { a, b } = await twoOrgs();
    const created = await connections.create(a, posthog());
    if (!created.ok) throw new Error(created.error.code);
    const connectionId = created.data.id;
    const app = await appsService.create(a, { prompt: "Signups", connectionIds: [connectionId] });
    if (!app.ok) throw new Error(app.error.code);
    const appId = app.data.id;
    await dashboards.record(a, appId, { artifactId: "art_a", title: "Signups", description: null });
    const threadId = "11111111-2222-4333-8444-555555555555";
    expect(await threads.register(a, appId, { threadId, title: "Hello" })).toMatchObject({ ok: true });

    // Org A sees it all.
    expect((await connections.list(a)).map((c) => c.id)).toEqual([connectionId]);
    expect(await connections.open(a, connectionId, "posthog")).not.toBeNull();
    expect(await appsService.get(a, appId)).not.toBeNull();
    expect(await dashboards.findByArtifact(a, "art_a")).not.toBeNull();

    // Org B, even knowing every id, finds nothing and can change nothing.
    expect(await connections.list(b)).toEqual([]);
    expect(await connections.open(b, connectionId, "posthog")).toBeNull();
    expect(await connections.rename(b, { id: connectionId, name: "Mine" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await connections.remove(b, { id: connectionId })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await appsService.list(b)).toEqual([]);
    expect(await appsService.get(b, appId)).toBeNull();
    expect(await appsService.remove(b, { id: appId })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await appsService.recordConnectionUse(b, appId, connectionId)).toMatchObject({ ok: false });
    expect(await dashboards.findByArtifact(b, "art_a")).toBeNull();
    expect(await dashboards.list(b, appId)).toEqual([]);
    expect(await dashboards.record(b, appId, { artifactId: "art_b", title: "x", description: null })).toBeFalsy();
    expect(await threads.belongsTo(b, appId, threadId)).toBe(false);
    expect(await threads.list(b, appId)).toMatchObject({ ok: false, error: { code: "not_found" } });
    // B can't make A's app use B's connection, or A's connection in B's app.
    const bConnection = await connections.create(b, posthog("B's"));
    if (!bConnection.ok) throw new Error(bConnection.error.code);
    expect(await appsService.addConnection(a, { appId, connectionId: bConnection.data.id })).toMatchObject({ ok: false });
  });

  it("separates a person's work in two organisations", async () => {
    const { a } = await twoOrgs();
    const personal: Scope = { orgId: await orgService.ensurePersonal(alice), userId: alice.id, role: "owner" };
    const inTeam = await connections.create(a, posthog("Team"));
    const inPersonal = await connections.create(personal, posthog("Mine"));
    if (!inTeam.ok || !inPersonal.ok) throw new Error("create failed");
    expect((await connections.list(a)).map((c) => c.name)).toEqual(["Team"]);
    expect((await connections.list(personal)).map((c) => c.name)).toEqual(["Mine"]);
    expect(await connections.open(personal, inTeam.data.id, "posthog")).toBeNull();
  });

  it("shares an organisation's connections with its members, who change only their own", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    await join(orgId, owner, bob, "member");
    await join(orgId, owner, carol, "viewer");
    const asAlice: Scope = { orgId, userId: alice.id, role: "owner" };
    const asBob: Scope = { orgId, userId: bob.id, role: "member" };
    const asCarol: Scope = { orgId, userId: carol.id, role: "viewer" };

    const alices = await connections.create(asAlice, posthog("Alice's"));
    const bobs = await connections.create(asBob, posthog("Bob's"));
    if (!alices.ok || !bobs.ok) throw new Error("create failed");
    // Everyone in the organisation can use both.
    expect(await connections.list(asCarol)).toHaveLength(2);
    expect(await connections.open(asBob, alices.data.id, "posthog")).not.toBeNull();
    // A member changes their own, not someone else's; an owner or admin changes any.
    expect(await connections.rename(asBob, { id: bobs.data.id, name: "Bob's prod" })).toEqual({ ok: true, data: undefined });
    expect(await connections.rename(asBob, { id: alices.data.id, name: "Mine now" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await connections.remove(asBob, { id: alices.data.id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await connections.rename(asAlice, { id: bobs.data.id, name: "Renamed by owner" })).toEqual({ ok: true, data: undefined });
    // Viewers add and change nothing.
    expect(await connections.create(asCarol, posthog("Carol's"))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await connections.rename(asCarol, { id: bobs.data.id, name: "x" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("lets only an app's creator or an admin delete it, and keeps a pending prompt for its creator", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    await join(orgId, owner, bob, "member");
    await join(orgId, owner, carol, "member");
    const asBob: Scope = { orgId, userId: bob.id, role: "member" };
    const asCarol: Scope = { orgId, userId: carol.id, role: "member" };
    const connection = await connections.create(asBob, posthog());
    if (!connection.ok) throw new Error(connection.error.code);
    const app = await appsService.create(asBob, { prompt: "Weekly signups", connectionIds: [connection.data.id] });
    if (!app.ok) throw new Error(app.error.code);

    expect(await appsService.takePendingPrompt(asCarol, app.data.id)).toBeNull();
    expect(await appsService.takePendingPrompt(asBob, app.data.id)).toMatchObject({ prompt: "Weekly signups" });
    expect(await appsService.remove(asCarol, { id: app.data.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await appsService.remove({ orgId, userId: alice.id, role: "owner" }, { id: app.data.id })).toEqual({ ok: true, data: undefined });
  });

  it("keeps each member's chat threads to themselves", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    await join(orgId, owner, bob, "member");
    const asAlice: Scope = { orgId, userId: alice.id, role: "owner" };
    const asBob: Scope = { orgId, userId: bob.id, role: "member" };
    const connection = await connections.create(asAlice, posthog());
    if (!connection.ok) throw new Error(connection.error.code);
    const app = await appsService.create(asAlice, { prompt: "Signups", connectionIds: [connection.data.id] });
    if (!app.ok) throw new Error(app.error.code);
    const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await threads.register(asAlice, app.data.id, { threadId, title: "Alice's chat" });
    expect(await threads.belongsTo(asBob, app.data.id, threadId)).toBe(false);
    expect(await threads.list(asBob, app.data.id)).toEqual({ ok: true, data: { threads: [] } });
  });

  it("seals connection keys to their organisation: a secret copied into another organisation's row won't open", async () => {
    const { a, b } = await twoOrgs();
    const inA = await connections.create(a, posthog("A"));
    const inB = await connections.create(b, posthog("B"));
    if (!inA.ok || !inB.ok) throw new Error("create failed");
    const [rowA] = await db.select().from(dataConnections).where(eq(dataConnections.id, inA.data.id));
    expect(rowA.secret).toMatchObject({ provider: "aes-gcm", org: true });
    expect(JSON.stringify(rowA.secret)).not.toContain("phx_abcdefghijklmnopqrstuvwxyz1234");
    // A database-level attacker copies A's sealed key into B's row: it won't decrypt.
    await db.update(dataConnections).set({ secret: rowA.secret }).where(eq(dataConnections.id, inB.data.id));
    await expect(connections.open(b, inB.data.id, "posthog")).rejects.toBeInstanceOf(SecretUnreadableError);
  });

  it("enforces an organisation's MCP host allow-list when a server is added", async () => {
    const { a } = await twoOrgs();
    settingsByOrg.set(a.orgId, { mcpAllowedHosts: ["*.trusted.test"] });
    const add = (url: string) => connections.create(a, { type: "mcp", name: "MCP", url, headerName: "Authorization", apiKey: "k" });
    expect(await add("https://mcp.evil.test/mcp")).toMatchObject({ ok: false, error: { code: "policy_blocked", field: "url" } });
    expect(await add("https://mcp.trusted.test/mcp")).toMatchObject({ ok: true });
  });

  it("lets only admins set an MCP server's allowed tools", async () => {
    const orgId = await teamOrg(alice);
    const owner: OrgActor = { orgId, userId: alice.id, role: "owner" };
    await join(orgId, owner, bob, "member");
    const created = await connections.create({ orgId, userId: bob.id, role: "member" }, { type: "mcp", name: "MCP", url: "https://mcp.example.test/mcp", apiKey: "k" });
    if (!created.ok) throw new Error(created.error.code);
    const input = { id: created.data.id, allowedTools: ["list_invoices"] };
    expect(await connections.setMcpAllowedTools({ orgId, userId: bob.id, role: "member" }, input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await connections.setMcpAllowedTools({ orgId, userId: alice.id, role: "owner" }, input)).toEqual({ ok: true, data: undefined });
    expect(await connections.mcpPolicies({ orgId, userId: alice.id })).toEqual([
      { id: created.data.id, name: "MCP", host: "mcp.example.test", allowedTools: ["list_invoices"] },
    ]);
  });
});

describe("the migration's compatibility trigger", () => {
  it("files a row written without an organisation (an old deployment during rollout) under its creator's personal organisation", async () => {
    await db.execute(sql`INSERT INTO apps (user_id, name) VALUES ('rollout-user', 'Old writer')`);
    const [row] = await db.select().from(apps).where(eq(apps.userId, "rollout-user"));
    expect(row.orgId).toBe(await orgService.ensurePersonal({ id: "rollout-user", email: "r@x.test" }));
  });
});
