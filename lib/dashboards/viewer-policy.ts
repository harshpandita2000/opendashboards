import { evaluate, parseExpression, split, tokenize, type ASTNode } from "@openuidev/lang-core";

/**
 * What a viewer's dashboard may run. Viewers open dashboards; they don't
 * write queries. So for a viewer, the interpreter runs a data call only if
 * the dashboard's own program could have made it: the same tool, and
 * arguments the program's Query() computes from its filters.
 *
 * How: each Query's tool name and arguments are evaluated with every state
 * variable ($range, …) set to each value the program offers for it (its
 * default and every `value:` in its option lists) and to a placeholder. A
 * call matches when its arguments equal one of those evaluations, with any
 * placeholder standing for a short, inert token: letters, digits and
 * `_ . : - /` only (no spaces, quotes, brackets, `;`, `,`, `--` or `/*`), which
 * covers dates, date ranges and ids but can't extend a SQL statement.
 * Filter values chosen from the program's options always match. A custom
 * value goes through only in that token shape, so a free-text filter (with
 * spaces, say) is refused for viewers, and members see it as usual.
 *
 * Only Query() calls count: a dashboard's Mutation()s (buttons that write) never
 * run for a viewer.
 */

const HOLE = /^[A-Za-z0-9_.:\-/]{0,64}$/;
const HOLE_CHARS = "[A-Za-z0-9_.:\\-/]{0,64}";
/** Placeholders can't occur in real program text: they use private-use characters. */
const sentinel = (index: number) => `\uE000${index}\uE001`;
const SENTINEL_PATTERN = /\uE000\d+\uE001/g;
const HAS_SENTINEL = /\uE000\d+\uE001/;
const MAX_COMBINATIONS = 256;
const MAX_TEMPLATES = 2_000;

export type CompiledProgram = { templates: Map<string, unknown[]> };

type Statements = Record<string, ASTNode>;

/** Compiles a stored dashboard program into the calls it can make. Exported for tests. */
export function compileProgram(program: string): CompiledProgram {
  const statements: Statements = {};
  for (const statement of split(tokenize(program))) {
    try {
      statements[statement.id] = parseExpression(statement.tokens);
    } catch {
      // A statement that doesn't parse can't make a call.
    }
  }

  const stateNames = Object.keys(statements).filter((id) => id.startsWith("$"));
  const optionValues = collectOptionValues(Object.values(statements));
  const candidates = stateNames.map((name, index) => {
    const values = new Set<unknown>([safeEvaluate(statements[name]!, statements, {}), ...optionValues, sentinel(index)]);
    return [...values];
  });

  const queries = Object.entries(statements).filter(([, node]) => node.k === "Comp" && node.name === "Query");
  const templates = new Map<string, unknown[]>();
  const seen = new Set<string>();
  let count = 0;
  for (const assignment of assignments(stateNames, candidates)) {
    for (const [, node] of queries) {
      if (node.k !== "Comp") continue;
      const [toolNode, argsNode] = node.args;
      if (!toolNode) continue;
      const tool = safeEvaluate(toolNode, statements, assignment);
      if (typeof tool !== "string") continue;
      const args = argsNode ? safeEvaluate(argsNode, statements, assignment) : {};
      if (args === undefined) continue;
      const key = `${tool}\u0000${JSON.stringify(args)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      templates.set(tool, [...(templates.get(tool) ?? []), args]);
      if (++count >= MAX_TEMPLATES) return { templates };
    }
  }
  return { templates };
}

/** Whether a viewer's data call is one the program could make. */
export function isCallAllowed(compiled: CompiledProgram, name: string, args: unknown): boolean {
  const candidates = compiled.templates.get(name);
  if (!candidates) return false;
  return candidates.some((template) => matches(template, args ?? {}));
}

function matches(template: unknown, value: unknown): boolean {
  if (typeof template === "string") {
    if (!HAS_SENTINEL.test(template)) return value === template;
    // A whole value from state: any number, boolean or null, or an inert token.
    if (/^\uE000\d+\uE001$/.test(template)) {
      return value === null || typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && inert(value));
    }
    if (typeof value !== "string") return false;
    const parts = template.split(SENTINEL_PATTERN);
    const pattern = new RegExp(`^${parts.map(escapeRegExp).join(`(${HOLE_CHARS})`)}$`, "s");
    const match = pattern.exec(value);
    return Boolean(match && match.slice(1).every(inert));
  }
  if (template === null || typeof template !== "object") {
    // A number or boolean that came from state can't be told from a literal here; equality is the safe test.
    return Object.is(template, value) || (template === null && value === undefined);
  }
  if (Array.isArray(template)) {
    return Array.isArray(value) && value.length === template.length && template.every((item, index) => matches(item, value[index]));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const expected = template as Record<string, unknown>;
  const actual = value as Record<string, unknown>;
  for (const key of Object.keys(actual)) if (!(key in expected)) return false;
  return Object.entries(expected).every(([key, item]) => matches(item, actual[key]));
}

function inert(value: string): boolean {
  return HOLE.test(value) && !value.includes("--") && !value.includes("/*") && !value.includes("*/");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every `value:` in the program's option lists ({value: "7d", label: …}): what its filters can be set to. */
function collectOptionValues(nodes: ASTNode[]): unknown[] {
  const values = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const ast = node as ASTNode;
    if (ast.k === "Obj") {
      for (const [key, value] of ast.entries) {
        if (key === "value" && (value.k === "Str" || value.k === "Num" || value.k === "Bool")) values.add(value.v);
      }
    }
    for (const child of Object.values(ast)) if (child && typeof child === "object") visit(child);
  };
  nodes.forEach(visit);
  return [...values].slice(0, 64);
}

/**
 * Every assignment of candidate values to state variables, up to a cap. Past
 * it: every variable at its default, then each one varied alone, then all at
 * their placeholders.
 */
function* assignments(names: string[], candidates: unknown[][]): Generator<Record<string, unknown>> {
  const total = candidates.reduce((product, values) => product * values.length, 1);
  if (total <= MAX_COMBINATIONS) {
    const indexes = names.map(() => 0);
    for (let n = 0; n < total; n++) {
      yield Object.fromEntries(names.map((name, i) => [name, candidates[i]![indexes[i]!]]));
      for (let i = 0; i < indexes.length; i++) {
        indexes[i]! += 1;
        if (indexes[i]! < candidates[i]!.length) break;
        indexes[i] = 0;
      }
    }
    return;
  }
  const defaults = Object.fromEntries(names.map((name, i) => [name, candidates[i]![0]]));
  yield defaults;
  for (let i = 0; i < names.length; i++) {
    for (const value of candidates[i]!.slice(1)) yield { ...defaults, [names[i]!]: value };
  }
  yield Object.fromEntries(names.map((name, i) => [name, sentinel(i)]));
}

function safeEvaluate(node: ASTNode, statements: Statements, state: Record<string, unknown>): unknown {
  const resolving = new Set<string>();
  const context = {
    getState: (name: string) => state[name] ?? state[`$${name}`] ?? null,
    resolveRef: (name: string): unknown => {
      const target = statements[name];
      // Another query's results aren't known here: a call that depends on them doesn't match.
      if (!target || resolving.has(name) || (target.k === "Comp" && (target.name === "Query" || target.name === "Mutation"))) {
        return undefined;
      }
      resolving.add(name);
      try {
        return evaluate(target, context);
      } finally {
        resolving.delete(name);
      }
    },
  };
  try {
    return evaluate(node, context);
  } catch {
    return undefined;
  }
}
