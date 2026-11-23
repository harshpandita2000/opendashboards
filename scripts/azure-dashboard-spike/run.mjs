// Azure dashboard spike: can a customer's own Azure OpenAI deployment write valid
// OpenDashboards dashboards (OpenUI Lang over @openuidev/dashboard-library) without
// OpenUI Cloud? See README.md next to this file.
//
//   pnpm dashboard:spec && node scripts/azure-dashboard-spike/run.mjs
//
// It builds the generation system prompt from the repo's own library spec and prompt
// options (lib/dashboards/generated/*), calls Azure directly, then checks each output:
//   1. parses against the library's JSON schema (no errors, nothing unresolved, complete);
//   2. every Query() uses a known tool with this connection;
//   3. (when SPIKE_DATABASE_URL reaches the sample dataset) every query's SQL, evaluated
//      with the dashboard's default filter values, runs read-only and returns rows.
// Invalid output gets up to SPIKE_MAX_REPAIRS repair rounds with the errors fed back.
// The API key is read from the environment and never printed or written anywhere.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createParser, evaluate, generateSystemPrompt, parseExpression, split, tokenize } from "@openuidev/lang-core";
import { AzureOpenAI } from "openai";
import pg from "pg";

import { CONNECTION_ID, PROMPTS, SCHEMA_DESCRIPTION } from "./prompts.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const env = {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT || "https://azropnai1.openai.azure.com/",
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5-mini",
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2025-04-01-preview",
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  reasoningEffort: process.env.SPIKE_REASONING_EFFORT || "low",
  maxRepairs: Number(process.env.SPIKE_MAX_REPAIRS ?? 2),
  concurrency: Number(process.env.SPIKE_CONCURRENCY ?? 1),
  only: process.env.SPIKE_ONLY ? process.env.SPIKE_ONLY.split(",") : null,
  databaseUrl: process.env.SPIKE_DATABASE_URL ?? "postgres://opendashboards:opendashboards@localhost:54329/spike_retail",
  maxCompletionTokens: Number(process.env.SPIKE_MAX_COMPLETION_TOKENS ?? 32000),
};
if (!env.apiKey) {
  console.error("AZURE_OPENAI_API_KEY is not set. Set it (and optionally AZURE_OPENAI_ENDPOINT / _DEPLOYMENT / _API_VERSION) and run again.");
  process.exit(2);
}

// The repo's own generation inputs, as OpenUI Cloud receives them.
const specPath = join(root, "lib/dashboards/generated/dashboard.spec.json");
let spec, promptOptions;
try {
  spec = JSON.parse(readFileSync(specPath, "utf8"));
  promptOptions = JSON.parse(readFileSync(join(root, "lib/dashboards/generated/dashboard.prompt.json"), "utf8"));
} catch {
  console.error("Missing lib/dashboards/generated/*. Run `pnpm dashboard:spec` first.");
  process.exit(2);
}

// postgres_query exactly as lib/sources/postgres/source.ts + lib/tools/index.ts describe it to dashboards.
const TOOLS = [
  {
    name: "postgres_query",
    description:
      "Run one read-only SELECT on the database. Pass filter values as params and reference them as $1, $2, … " +
      "instead of writing them into the SQL. Returns { columns, rows: [{ column: value }], truncated }.",
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", description: "The connection's id, from list_connections." },
        sql: { type: "string", minLength: 1, description: "One SELECT (or WITH … SELECT) statement." },
        params: { type: "array", items: { type: ["string", "number", "boolean", "null"] }, description: "Values for $1, $2, … in order." },
      },
      required: ["connection", "sql"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "object" } }, truncated: { type: "boolean" } },
    },
    annotations: { readOnlyHint: true },
  },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const systemPrompt = generateSystemPrompt({ library: spec, promptOptions: { ...promptOptions, tools: TOOLS } });
const parser = createParser(spec.schema, spec.root);

// Small deployments have low tokens-per-minute quotas and each call sends ~12k prompt
// tokens, so 429s are expected: the SDK backs off (honouring Retry-After) and retries.
const client = new AzureOpenAI({
  endpoint: env.endpoint,
  apiKey: env.apiKey,
  apiVersion: env.apiVersion,
  deployment: env.deployment,
  maxRetries: Number(process.env.SPIKE_MAX_RETRIES ?? 8),
  timeout: 300_000,
});

let pool = null;
try {
  pool = new pg.Pool({ connectionString: env.databaseUrl, max: 4, connectionTimeoutMillis: 3000 });
  await pool.query("SELECT 1 FROM analytics.monthly_business_kpis LIMIT 1");
} catch (error) {
  console.warn(`Sample database not reachable (${error.code ?? error.message}); skipping SQL execution checks.`);
  await pool?.end().catch(() => {});
  pool = null;
}

function userMessage(p) {
  return `Create a dashboard titled "${p.title}".\n\n${p.prompt}\n\nLoad every part with postgres_query on connection "${CONNECTION_ID}" (pass it as the connection argument). The data:\n\n${SCHEMA_DESCRIPTION}`;
}

/** The program, without a Markdown fence if the model added one. */
function extractProgram(text) {
  const fenced = text.match(/```[a-zA-Z-]*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/** Evaluates every Query()'s tool and arguments with the dashboard's default $state values. */
async function runQueries(program, parsed) {
  const statements = new Map();
  for (const s of split(tokenize(program))) {
    try {
      statements.set(s.id, parseExpression(s.tokens));
    } catch {
      /* the parser already reports syntax problems */
    }
  }
  const queryIds = new Set(parsed.queryStatements.map((q) => q.statementId));
  const results = new Map();
  const values = new Map();
  const problems = [];
  const resolving = new Set();

  const ctx = {
    getState: (name) => parsed.stateDeclarations[name.startsWith("$") ? name : `$${name}`],
    resolveRef(name) {
      if (queryIds.has(name)) return results.get(name) ?? { rows: [], columns: [], truncated: false };
      if (values.has(name)) return values.get(name);
      const ast = statements.get(name);
      if (!ast || resolving.has(name)) return null;
      resolving.add(name);
      let value = null;
      try {
        value = evaluate(ast, ctx);
      } catch {
        value = null;
      }
      resolving.delete(name);
      values.set(name, value);
      return value;
    },
    reportError: () => {},
  };

  // Queries that read other queries' results run after them.
  const pending = [...parsed.queryStatements];
  const done = new Set();
  let guard = 0;
  const summary = [];
  while (pending.length && guard++ < 100) {
    const index = pending.findIndex((q) => (q.waitFor ?? []).every((id) => done.has(id) || !queryIds.has(id)));
    const q = pending.splice(index === -1 ? 0 : index, 1)[0];
    const tool = q.toolAST ? evaluate(q.toolAST, ctx) : null;
    const args = q.argsAST ? evaluate(q.argsAST, ctx) : {};
    const entry = { query: q.statementId, tool };
    if (!TOOL_NAMES.has(tool)) {
      problems.push(`Query ${q.statementId} calls unknown tool ${JSON.stringify(tool)}; the only tool is postgres_query.`);
    } else if (!args || args.connection !== CONNECTION_ID) {
      problems.push(`Query ${q.statementId} must pass connection: "${CONNECTION_ID}".`);
    } else if (typeof args.sql !== "string" || !args.sql.trim()) {
      problems.push(`Query ${q.statementId} has no sql string.`);
    } else if (pool) {
      const sqlClient = await pool.connect();
      try {
        await sqlClient.query("BEGIN READ ONLY");
        await sqlClient.query("SET LOCAL statement_timeout = 10000");
        const result = await sqlClient.query(args.sql, Array.isArray(args.params) ? args.params : []);
        entry.rows = result.rowCount;
        results.set(q.statementId, { columns: result.fields.map((f) => f.name), rows: result.rows, truncated: false });
        if (result.rowCount === 0) entry.empty = true;
      } catch (error) {
        entry.error = error.message;
        problems.push(`Query ${q.statementId} failed in PostgreSQL: ${error.message}. SQL was: ${args.sql}`);
      } finally {
        await sqlClient.query("ROLLBACK").catch(() => {});
        sqlClient.release();
      }
    }
    done.add(q.statementId);
    summary.push(entry);
  }
  return { problems, queries: summary };
}

async function check(text) {
  const program = extractProgram(text);
  const parsed = parser.parse(program);
  const problems = [];
  if (!parsed.root) problems.push(`No root: the program must assign root = ${spec.root}(...).`);
  if (parsed.meta.incomplete) problems.push("The program is incomplete (unclosed string or bracket).");
  for (const e of parsed.meta.errors) problems.push(`Validation error: ${e.message ?? JSON.stringify(e)}`);
  if (parsed.meta.unresolved.length) problems.push(`Undefined references: ${[...new Set(parsed.meta.unresolved)].join(", ")}.`);
  if (!parsed.queryStatements.length) problems.push("The dashboard has no Query(): it must load live data with postgres_query.");
  const syntaxOk = problems.length === 0;
  let queries = [];
  if (parsed.root) {
    const run = await runQueries(program, parsed);
    problems.push(...run.problems);
    queries = run.queries;
  }
  return { program, syntaxOk, valid: problems.length === 0, problems, queries, statementCount: parsed.meta.statementCount, orphaned: parsed.meta.orphaned };
}

async function complete(messages) {
  const started = performance.now();
  const response = await client.chat.completions.create({
    model: env.deployment,
    messages,
    reasoning_effort: env.reasoningEffort,
    max_completion_tokens: env.maxCompletionTokens,
  });
  const ms = Math.round(performance.now() - started);
  const usage = response.usage ?? {};
  return {
    text: response.choices[0]?.message?.content ?? "",
    finishReason: response.choices[0]?.finish_reason,
    ms,
    usage: {
      prompt: usage.prompt_tokens ?? 0,
      cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
      completion: usage.completion_tokens ?? 0,
      reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

async function runOne(p) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage(p) },
  ];
  const attempts = [];
  for (let attempt = 0; attempt <= env.maxRepairs; attempt++) {
    let call;
    try {
      call = await complete(messages);
    } catch (error) {
      attempts.push({ attempt, apiError: `${error.status ?? ""} ${String(error.message).slice(0, 300)}` });
      break;
    }
    const result = await check(call.text);
    attempts.push({ attempt, ms: call.ms, usage: call.usage, finishReason: call.finishReason, ...result });
    if (result.valid) break;
    messages.push({ role: "assistant", content: call.text });
    messages.push({
      role: "user",
      content: `The dashboard program has problems:\n- ${result.problems.slice(0, 15).join("\n- ")}\n\nReturn the complete corrected program only.`,
    });
  }
  const last = attempts.at(-1);
  const totals = attempts.reduce(
    (t, a) => ({
      ms: t.ms + (a.ms ?? 0),
      prompt: t.prompt + (a.usage?.prompt ?? 0),
      cached: t.cached + (a.usage?.cached ?? 0),
      completion: t.completion + (a.usage?.completion ?? 0),
      reasoning: t.reasoning + (a.usage?.reasoning ?? 0),
    }),
    { ms: 0, prompt: 0, cached: 0, completion: 0, reasoning: 0 },
  );
  const outcome = {
    id: p.id,
    apiError: attempts.some((a) => a.apiError) && !attempts.some((a) => a.valid) ? attempts.find((a) => a.apiError).apiError : null,
    validFirstTry: attempts[0]?.valid === true,
    syntaxOkFirstTry: attempts[0]?.syntaxOk === true,
    validFinal: last?.valid === true,
    repairs: Math.max(0, attempts.length - 1),
    queries: last?.queries?.length ?? 0,
    emptyQueries: last?.queries?.filter((q) => q.empty).length ?? 0,
    totals,
    attempts,
  };
  const mark = outcome.apiError
    ? `API ERROR (${outcome.apiError.trim().slice(0, 40)})`
    : outcome.validFirstTry
      ? "valid"
      : outcome.validFinal
        ? `valid after ${outcome.repairs} repair(s)`
        : "INVALID";
  console.log(`${p.id.padEnd(18)} ${mark.padEnd(22)} ${String(totals.ms).padStart(6)} ms  ${totals.prompt}+${totals.completion} tok (${totals.reasoning} reasoning)  ${outcome.queries} queries`);
  return outcome;
}

async function pMap(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const host = new URL(env.endpoint).host;
console.log(`Azure ${host} · deployment ${env.deployment} · api-version ${env.apiVersion} · reasoning ${env.reasoningEffort}`);
console.log(`System prompt: ${systemPrompt.length} chars · SQL checks: ${pool ? "on" : "off"} · repairs: up to ${env.maxRepairs}\n`);

const selected = env.only ? PROMPTS.filter((p) => env.only.includes(p.id)) : PROMPTS;
const started = Date.now();
const outcomes = await pMap(selected, env.concurrency, runOne);
await pool?.end();

const errored = outcomes.filter((o) => o.apiError);
const scored = outcomes.filter((o) => !o.apiError);
const n = scored.length;
const pct = (k) => `${k}/${n} (${n ? Math.round((100 * k) / n) : 0}%)`;
const firstCalls = scored.map((o) => o.attempts[0]).filter((a) => a?.ms);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};
const summary = {
  when: new Date().toISOString(),
  endpointHost: host,
  deployment: env.deployment,
  apiVersion: env.apiVersion,
  reasoningEffort: env.reasoningEffort,
  sqlChecks: Boolean(pool),
  prompts: outcomes.length,
  scored: n,
  apiErrors: errored.length,
  validFirstTry: scored.filter((o) => o.validFirstTry).length,
  syntaxOkFirstTry: scored.filter((o) => o.syntaxOkFirstTry).length,
  validFinal: scored.filter((o) => o.validFinal).length,
  neededRepair: scored.filter((o) => !o.validFirstTry && o.validFinal).length,
  totalRepairs: scored.reduce((t, o) => t + o.repairs, 0),
  latencyFirstCallMs: { median: median(firstCalls.map((a) => a.ms)), max: Math.max(0, ...firstCalls.map((a) => a.ms)) },
  latencyToValidMs: { median: median(scored.filter((o) => o.validFinal).map((o) => o.totals.ms)), max: Math.max(0, ...scored.map((o) => o.totals.ms)) },
  tokensPerDashboard: {
    prompt: Math.round(scored.reduce((t, o) => t + o.totals.prompt, 0) / Math.max(1, n)),
    cached: Math.round(scored.reduce((t, o) => t + o.totals.cached, 0) / Math.max(1, n)),
    completion: Math.round(scored.reduce((t, o) => t + o.totals.completion, 0) / Math.max(1, n)),
    reasoning: Math.round(scored.reduce((t, o) => t + o.totals.reasoning, 0) / Math.max(1, n)),
  },
  queries: scored.reduce((t, o) => t + o.queries, 0),
  emptyQueries: scored.reduce((t, o) => t + o.emptyQueries, 0),
  wallClockMs: Date.now() - started,
};

if (errored.length) console.log(`\n${errored.length} prompt(s) hit API errors (rate limit or network) and are not scored.`);
console.log(`\nValid first try: ${pct(summary.validFirstTry)} (syntax/schema only: ${pct(summary.syntaxOkFirstTry)})`);
console.log(`Valid after repair: ${pct(summary.validFinal)} · needed repair: ${summary.neededRepair} · repair rounds: ${summary.totalRepairs}`);
console.log(`First-call latency median ${summary.latencyFirstCallMs.median} ms (max ${summary.latencyFirstCallMs.max}) · to valid median ${summary.latencyToValidMs.median} ms`);
console.log(`Tokens per dashboard (avg): ${summary.tokensPerDashboard.prompt} prompt (${summary.tokensPerDashboard.cached} cached) + ${summary.tokensPerDashboard.completion} completion (${summary.tokensPerDashboard.reasoning} reasoning)`);
console.log(`Queries: ${summary.queries} (${summary.emptyQueries} returned no rows)`);

const outDir = join(here, "results");
mkdirSync(outDir, { recursive: true });
const stamp = summary.when.replace(/[:.]/g, "-");
const file = join(outDir, `run-${env.deployment}-${env.reasoningEffort}-${stamp}.json`);
writeFileSync(file, `${JSON.stringify({ summary, outcomes }, null, 2)}\n`);
console.log(`\nFull results (programs, errors, per-attempt usage): ${file}`);
