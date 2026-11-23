# Azure dashboard spike: results

**Run:** 23 Nov 2026, 14:38–15:00 IST, against `azropnai1.openai.azure.com`.
**Model:** deployment `gpt-5-mini` (model `gpt-5-mini-2025-08-07`), api-version `2025-04-01-preview`, Chat Completions.
**Setup:** 10 prompts (`prompts.mjs`), the sample retail dataset (`sample-schema.sql`) with SQL checks on, concurrency 1, up to 2 repair rounds.
The `cognitiveservices.azure.com` host for the same resource also works.

**What "valid" means:**
- The program parses against `@openuidev/dashboard-library`'s schema with no errors, nothing unresolved, and nothing incomplete.
- Every `Query()` calls `postgres_query` with the right connection.
- Every query's SQL, evaluated with the dashboard's default filter values, runs read-only in PostgreSQL without error.

| | reasoning `low` | reasoning `medium` |
|---|---|---|
| Valid on the first try | 3/10 (30%) | **7/10 (70%)** |
| Valid after repair (≤2 rounds) | 8/10 (80%) | **10/10 (100%)** |
| Prompts that needed a repair | 5 (10 rounds in total) | 3 (1 round each) |
| First-call latency, median (max) | 44.6 s (59 s) | 44.3 s (72 s) |
| Time to a valid dashboard, median (max) | 52 s (117 s) | 49 s (95 s) |
| Tokens per dashboard (avg) | 25.4k prompt (23.0k cached) + 4.1k completion (1.9k reasoning) | 15.6k prompt (14.6k cached) + 6.6k completion (5.1k reasoning) |
| Queries generated / returning no rows | 22 / 0 | 26 / 0 |
| SQL errors | none in either run | none in either run |

Raw per-prompt results (programs, errors, usage per attempt) are in `results/` on the box where the spike ran; that folder is not committed.

## What went wrong, and how often
All failures were OpenUI Lang / schema errors. The SQL was correct every time. The most common errors, by count over both runs' attempts:

1. A string passed where a component is expected, e.g. `Kpis(["Revenue", …])` instead of `Kpi(...)`, or a string `chart` in `Kpi`.
2. A required prop set to null, e.g. `Series(name, values)` or `Column(label, values)` where `values` refers to a field that doesn't exist.
3. `Query()` used inline instead of as a top-level statement.
4. Truncated programs, usually a missing `]` that ends `FilterBar([...])` and swallows the next component. This also causes the cascading "undefined references" errors.
5. A dashboard with no `Query()` at all (it hard-coded values).
6. Wrong enum values (`goodWhen: "sum"`) and unknown components.

Every one of these is caught by `createParser(...).parse()` with a precise message, and a single repair round fixed it in almost every case.

## Verdict
**Bring-your-own Azure works for dashboard generation, without OpenUI Cloud**, as long as there's a server-side validate-and-repair loop and reasoning effort `medium` (or a stronger deployment):
- The local prompt (`generateSystemPrompt`) plus `createParser` validation plus one repair round reached 10/10 valid dashboards with working SQL on `gpt-5-mini`.
- Expect about 40–95 s per dashboard on `gpt-5-mini`. Stream it, and show progress while it builds.
- Very approximate cost at public gpt-5-mini list prices: about US$0.015 per dashboard at `medium` (most prompt tokens are cached). The customer pays this on their own Azure bill. Check current Azure pricing for the region.
- The system prompt is about 12k tokens. On low TPM quotas you'll get 429s when several users build at once. Size each customer's deployment TPM (≥100k recommended), retry with backoff, and queue builds per org.

## Not covered yet
- Rendering in the browser (`@openuidev/react-lang` `Renderer` plus the dashboard-library components) and runtime filter interactions. Only the default filter values were executed.
- Whether the numbers are *semantically right*, as opposed to valid and returning rows. That needs human review of a sample.
- Edit flows (`editMode`), very large schemas, and MCP-backed tools.
- Other deployments (`gpt-4.1`, `gpt-5`, `gpt-5-chat`) and the Responses API.
