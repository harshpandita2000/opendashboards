import { afterEach, describe, expect, it, vi } from "vitest";

import { captureRequestError, initSentry, sampleRate, sentryDsn } from "@/lib/observability/sentry";

describe("optional Sentry", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off without a DSN", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "  ");
    expect(sentryDsn("server")).toBeUndefined();
    expect(sentryDsn("client")).toBeUndefined();
    await expect(initSentry("server")).resolves.toBe(false);
  });

  it("does nothing when reporting while off", () => {
    expect(() =>
      captureRequestError(
        new Error("boom"),
        { path: "/x", method: "GET", headers: {} },
        { routerKind: "App Router", routePath: "/x", routeType: "route" },
      ),
    ).not.toThrow();
  });

  it("clamps sample rates", () => {
    expect(sampleRate(undefined, 0)).toBe(0);
    expect(sampleRate("abc", 0.1)).toBe(0.1);
    expect(sampleRate("0.25", 0)).toBe(0.25);
    expect(sampleRate("5", 0)).toBe(1);
    expect(sampleRate("-1", 0)).toBe(0);
  });
});
