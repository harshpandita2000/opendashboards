"use client";

import { useEffect, useRef } from "react";

import { switchOrgAction } from "@/app/(app)/settings/actions";

/**
 * Opening an app from another of the user's orgs (a link, say) makes that org
 * the open one, so the sidebar and connections match what's on screen.
 */
export function OpenAppOrg({ orgId }: { orgId: string }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void switchOrgAction(orgId);
  }, [orgId]);
  return null;
}
