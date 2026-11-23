/**
 * Optional error reporting with Sentry. Everything here is a no-op unless
 * SENTRY_DSN is set (NEXT_PUBLIC_SENTRY_DSN in the browser), so local
 * development, tests and deployments without Sentry behave exactly as before.
 * The SDK is imported lazily, only once a DSN is configured.
 *
 * Request bodies, cookies and headers are never sent (`dataCollection` off
 * and the scrub in `beforeSend`): connection forms carry API keys and passwords.
 */

type SentryModule = typeof import("@sentry/nextjs");

let sentry: SentryModule | null = null;

/** The DSN for this side, or undefined when Sentry is off. */
export function sentryDsn(side: "server" | "client"): string | undefined {
  const dsn = side === "server" ? process.env.SENTRY_DSN : process.env.NEXT_PUBLIC_SENTRY_DSN;
  return dsn && dsn.trim() ? dsn.trim() : undefined;
}

/** A sample rate from an env var, clamped to 0..1, else the fallback. */
export function sampleRate(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Initializes Sentry for this runtime when a DSN is set. Safe to call more than once. */
export async function initSentry(side: "server" | "client"): Promise<boolean> {
  if (sentry) return true;
  const dsn = sentryDsn(side);
  if (!dsn) return false;
  const mod = await import("@sentry/nextjs");
  mod.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: sampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE ?? process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0),
    // Collect no user info, cookies, headers, bodies, query strings, DB/MCP/LLM payloads or local variables.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
      }
      return event;
    },
  });
  sentry = mod;
  return true;
}

/** Reports a request error to Sentry, if it's on. For instrumentation.ts's onRequestError. */
export function captureRequestError(...args: Parameters<SentryModule["captureRequestError"]>): void {
  sentry?.captureRequestError(...args);
}
