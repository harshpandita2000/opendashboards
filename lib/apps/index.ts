import "server-only";

import { cache } from "react";

import { getDb } from "@/lib/db";
import { requireOrg } from "@/lib/orgs/current";

import { createAppService, type AppService } from "./service";
import { createThreadService, type ThreadService } from "./threads";

export type { AppDetail, AppSummary, AppTreeNode } from "./service";
export type { AppThread } from "./threads";

let appService: AppService | undefined;
let threadService: ThreadService | undefined;

export function getAppService(): AppService {
  appService ??= createAppService({ db: getDb() });
  return appService;
}

export function getThreadService(): ThreadService {
  threadService ??= createThreadService({ db: getDb() });
  return threadService;
}

/**
 * An app in the user's current organisation, or null. Cached per request, so
 * the app layout and the dashboard page share one lookup.
 */
export const getCurrentUserApp = cache(async (appId: string) => {
  const { scope } = await requireOrg();
  return getAppService().get(scope, appId);
});
