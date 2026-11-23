import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Connectors only talk to remote servers: the MCP SDK's stdio transport starts
      // a program on our side. Its SSE transport lets the server pick the URL we post
      // to, so it's used only in lib/sources/mcp, behind the single-origin guarded fetch.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@modelcontextprotocol/sdk/client/stdio*", "@modelcontextprotocol/sdk/client/sse*", "@modelcontextprotocol/sdk/client/websocket*"],
              message: "Only remote MCP transports, through lib/sources/mcp, are allowed.",
            },
          ],
        },
      ],
    },
  },
  {
    // The SSE fallback, pinned to the server's origin by the guarded fetch.
    files: ["lib/sources/mcp/client.ts", "lib/sources/mcp/errors.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@modelcontextprotocol/sdk/client/stdio*", "@modelcontextprotocol/sdk/client/websocket*"],
              message: "Only remote MCP transports are allowed.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "packages/*/dist/**",
  ]),
]);

export default eslintConfig;
