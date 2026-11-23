import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { AcceptInvite } from "@/components/settings/accept-invite";
import { requireUser } from "@/lib/auth/user";
import { getOrgService } from "@/lib/orgs";

export const metadata: Metadata = { title: "Join organisation" };

type Params = Promise<{ token: string }>;

export default function InvitePage({ params }: { params: Params }) {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-12">
      <Suspense fallback={null}>
        <Invite params={params} />
      </Suspense>
    </div>
  );
}

async function Invite({ params }: { params: Params }) {
  const { token } = await params;
  const user = await requireUser();
  const invite = await getOrgService().peekInvite(token);
  if (!invite) {
    return <PageHeader title="Invitation not found" description="This invitation is invalid, expired or already used. Ask for a new one." />;
  }
  const matches = invite.email === user.email.toLowerCase();
  return (
    <>
      <PageHeader
        title={`Join ${invite.orgName}`}
        description={
          matches
            ? `You've been invited as ${invite.role}.`
            : `This invitation is for ${invite.email}, and you're signed in as ${user.email}. Sign in with that address to accept it.`
        }
      />
      {matches && <AcceptInvite token={token} />}
    </>
  );
}
