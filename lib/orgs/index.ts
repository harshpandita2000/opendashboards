import "server-only";

import { getDb } from "@/lib/db";

import { createOrgService, type OrgService } from "./service";

export type { InviteSummary, Membership, MemberSummary, OrgActor, OrgResult } from "./service";

let orgService: OrgService | undefined;

export function getOrgService(): OrgService {
  orgService ??= createOrgService({ db: getDb() });
  return orgService;
}
