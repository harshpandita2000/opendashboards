import { z } from "zod";

import { isHost } from "@/lib/sources/host";

/**
 * Organisation-wide policies, stored on `orgs.settings`. Safe for the browser:
 * nothing here is secret.
 */
export const orgSettingsSchema = z
  .object({
    /**
     * MCP servers members may connect, by host name. A leading "*." allows
     * subdomains. Absent or null: any public HTTPS server (the network guard
     * still applies). An empty list allows none.
     */
    mcpAllowedHosts: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .refine((host) => isHost(host.replace(/^\*\./, "")), "Enter host names like mcp.example.com or *.example.com."),
      )
      .max(100)
      .nullable()
      .optional(),
  })
  .strict();

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

/** Whether an MCP server's host is allowed by the organisation's settings. */
export function mcpHostAllowed(settings: OrgSettings | null | undefined, host: string): boolean {
  const allowed = settings?.mcpAllowedHosts;
  if (allowed === undefined || allowed === null) return true;
  const h = host.toLowerCase();
  return allowed.some((entry) => (entry.startsWith("*.") ? h.endsWith(entry.slice(1)) && h !== entry.slice(2) : h === entry));
}
