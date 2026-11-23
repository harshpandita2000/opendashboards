import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compileProgram, isCallAllowed } from "@/lib/dashboards/viewer-policy";

const prompt = JSON.parse(readFileSync(new URL("../lib/dashboards/generated/dashboard.prompt.json", import.meta.url), "utf8")) as {
  examples: string[];
};
const program = prompt.examples[0];
const compiled = compileProgram(program);

const during = (start: string, end: string) => `day >= ${start} AND day <= ${end}`;
const totals = (where: string) => ({ query: `SELECT sum(revenue) AS revenue, sum(orders) AS orders FROM daily_sales WHERE ${where}` });

describe("what a viewer's dashboard may run", () => {
  it("allows the queries the dashboard makes with its default filters", () => {
    expect(isCallAllowed(compiled, "run_sql", totals(during("(current_date - 30)", "current_date")))).toBe(true);
    expect(isCallAllowed(compiled, "sales_by_channel", { range: "30d" })).toBe(true);
  });

  it("allows every option the filters offer", () => {
    expect(isCallAllowed(compiled, "run_sql", totals(during("(current_date - 7)", "current_date")))).toBe(true);
    expect(isCallAllowed(compiled, "sales_by_channel", { range: "90d" })).toBe(true);
  });

  it("allows a custom date range typed into the filter", () => {
    const range = "2024-01-01..2024-02-01";
    const where = during(`split_part('${range}', '..', 1)::date`, `split_part('${range}', '..', 2)::date`);
    expect(isCallAllowed(compiled, "run_sql", totals(where))).toBe(true);
    expect(isCallAllowed(compiled, "sales_by_channel", { range })).toBe(true);
  });

  it.each([
    ["a quote", "x'); DROP TABLE daily_sales; --"],
    ["a space", "1 OR 1=1"],
    ["a comment", "2024--01"],
    ["a block comment", "a/*b*/"],
  ])("refuses a filter value with %s", (_label, value) => {
    const where = during(`split_part('${value}', '..', 1)::date`, `split_part('${value}', '..', 2)::date`);
    expect(isCallAllowed(compiled, "run_sql", totals(where))).toBe(false);
  });

  it("refuses SQL the dashboard doesn't contain", () => {
    expect(isCallAllowed(compiled, "run_sql", { query: "SELECT * FROM users" })).toBe(false);
    expect(isCallAllowed(compiled, "run_sql", { query: `${totals(during("(current_date - 30)", "current_date")).query} UNION SELECT 1` })).toBe(false);
  });

  it("refuses tools the dashboard doesn't use, and arguments it doesn't pass", () => {
    expect(isCallAllowed(compiled, "delete_everything", {})).toBe(false);
    expect(isCallAllowed(compiled, "sales_by_channel", { range: "30d", limit: 1_000_000 })).toBe(false);
    expect(isCallAllowed(compiled, "sales_by_channel", {})).toBe(false);
    expect(isCallAllowed(compiled, "sales_by_channel", { range: { $ne: null } })).toBe(false);
  });

  it("refuses everything for a program that can't be read", () => {
    const broken = compileProgram("root = ");
    expect(isCallAllowed(broken, "run_sql", { query: "SELECT 1" })).toBe(false);
  });

  it("never runs a dashboard's mutations for a viewer: viewers are read-only", () => {
    const withMutation = compileProgram(
      `root = Dashboard([])\n$status = "open"\nsave = Mutation("update_ticket", {id: 42, status: $status})\nf = Select($status, [{value: "open", label: "Open"}, {value: "closed", label: "Closed"}])`,
    );
    expect(isCallAllowed(withMutation, "update_ticket", { id: 42, status: "open" })).toBe(false);
    expect(isCallAllowed(withMutation, "update_ticket", { id: 42, status: "closed" })).toBe(false);
    expect(isCallAllowed(withMutation, "update_ticket", { id: 43, status: "closed" })).toBe(false);
  });
});
