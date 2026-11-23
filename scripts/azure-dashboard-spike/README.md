# Azure dashboard spike

Tests whether a customer's **own Azure OpenAI deployment** can generate valid
OpenDashboards dashboards **without OpenUI Cloud**. Today the dashboards are
generated inside OpenUI Cloud, and that is the main blocker for "bring your own
Azure model".

## What it does

1. Builds the generation system prompt locally with `generateSystemPrompt` from
   `@openuidev/lang-core`. Its inputs are the repo's own library spec and prompt
   options (`lib/dashboards/generated/*`, from `pnpm dashboard:spec`) plus the
   `postgres_query` dashboard tool, described as `lib/sources/postgres/source.ts`
   describes it.
2. Sends 10 realistic requests (`prompts.mjs`) over a sample retail schema
   straight to Azure OpenAI (Chat Completions). Here the generator writes the SQL
   itself, which is stricter than production, where the Build agent usually hands
   over the exact queries.
3. Checks each output:
   - it parses against the library's JSON schema: a root, complete, no prop
     validation errors, no undefined references;
   - every `Query()` calls a known tool with the right `connection`;
   - if the sample database is reachable, every query's SQL is evaluated with the
     dashboard's default filter values and run read-only in PostgreSQL. Any error
     counts as invalid; empty results are reported.
4. When a check fails, it feeds the errors back to the model for up to
   `SPIKE_MAX_REPAIRS` repair rounds, the way a server-side repair loop would.
5. Reports the first-try valid rate, the valid rate after repair, latency, and
   token use (prompt, cached, completion, reasoning).

## Run

```bash
pnpm dashboard:spec
# optional, for the SQL checks: load the sample data into a local Postgres
createdb -h localhost -p 54329 -U opendashboards spike_retail
psql -h localhost -p 54329 -U opendashboards -d spike_retail -f scripts/azure-dashboard-spike/sample-schema.sql

export AZURE_OPENAI_API_KEY=...            # never committed or printed
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
export AZURE_OPENAI_DEPLOYMENT=gpt-5-mini
export AZURE_OPENAI_API_VERSION=2025-04-01-preview
pnpm spike:azure
```

| Option | Default | Meaning |
|---|---|---|
| `SPIKE_REASONING_EFFORT` | `low` | `minimal` / `low` / `medium` / `high`, for reasoning models |
| `SPIKE_MAX_REPAIRS` | `2` | Repair rounds after a failed check |
| `SPIKE_CONCURRENCY` | `1` | Requests in parallel |
| `SPIKE_ONLY` | all | Comma-separated prompt ids |
| `SPIKE_DATABASE_URL` | local `spike_retail` | Sample data for the SQL checks (skipped if unreachable) |
| `SPIKE_MAX_COMPLETION_TOKENS` | `32000` | Completion cap per call |

Full results (each program, its errors, and per-attempt usage) are written to
`results/`, which git ignores. A summary of the runs so far is in `REPORT.md`.
