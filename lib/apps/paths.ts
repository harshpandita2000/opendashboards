export const appPath = (appId: string) => `/apps/${appId}`;

export const dashboardPath = (appId: string, dashboardId: string) =>
  `/apps/${appId}/dashboards/${dashboardId}`;

/** Where the browser gets its OpenUI Cloud token for one app. */
export const frontendTokenPath = (appId: string) => `/api/apps/${encodeURIComponent(appId)}/frontend-token`;

/** Which app and dashboard a pathname points at, if any. */
export function parseAppPath(pathname: string | null): { appId?: string; dashboardId?: string } {
  const match = pathname?.match(/^\/apps\/([^/]+)(?:\/dashboards\/([^/]+))?/);
  return { appId: match?.[1], dashboardId: match?.[2] };
}
