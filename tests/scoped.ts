import { sql } from "drizzle-orm";

import type { Database } from "@/lib/db";
import type { Scope } from "@/lib/orgs/scope";

/**
 * Tests written before organisations call services as a user ("alice"). Each
 * user acts in their personal organisation, created by the migration's
 * `od_personal_org`, which is exactly how existing users were migrated: so
 * those tests still check that one user (organisation) can't reach another's
 * data. Tests of organisations themselves pass real scopes.
 */
export function orgsFor(db: Database) {
  const cache = new Map<string, Promise<string>>();
  const orgOf = (userId: string): Promise<string> => {
    let orgId = cache.get(userId);
    if (!orgId) {
      orgId = db.execute<{ id: string }>(sql`select od_personal_org(${userId}) as id`).then((result) => result.rows[0]!.id);
      cache.set(userId, orgId);
    }
    return orgId;
  };
  const scopeOf = async (userId: string): Promise<Scope> => ({ orgId: await orgOf(userId), userId });
  return { orgOf, scopeOf };
}

type AsUser<S> = {
  [K in keyof S]: S[K] extends (scope: Scope, ...args: infer A) => infer R ? (userId: string, ...args: A) => Promise<Awaited<R>> : S[K];
};

/** A service whose scoped methods take a user id instead, acting in that user's personal organisation. */
export function asUser<S extends object>(service: S, scopeOf: (userId: string) => Promise<Scope>, unscoped: string[] = []): AsUser<S> {
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || unscoped.includes(String(property))) return value;
      return async (first: unknown, ...rest: unknown[]) =>
        (value as (...args: unknown[]) => unknown).apply(target, [typeof first === "string" ? await scopeOf(first) : first, ...rest]);
    },
  }) as unknown as AsUser<S>;
}
