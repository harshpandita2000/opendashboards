import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SectionLabel } from "@/components/page-header";
import {
  DeleteWorkspaceButton,
  InviteForm,
  LeaveWorkspaceButton,
  MemberRow,
  PendingInviteRow,
  WorkspaceName,
} from "@/components/settings/members";
import { Skeleton } from "@/components/ui/skeleton";
import { getOrgService, requireMember } from "@/lib/orgs";
import { canManageMembers } from "@/lib/orgs/access";

export const metadata: Metadata = { title: "Workspace" };

export default function MembersPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <Suspense fallback={<MembersSkeleton />}>
        <Members />
      </Suspense>
    </div>
  );
}

/** Reads the user and the workspace they have open, so it streams in behind the boundary. */
async function Members() {
  const member = await requireMember();
  const org = await getOrgService().get(member.userId, member.orgId);
  if (!org) notFound();

  const admin = canManageMembers(org.role);
  const admins = org.members.filter((entry) => entry.role === "admin").length;
  return (
    <>
      <header className="mb-8">
        <WorkspaceName orgId={org.id} name={org.name} editable={admin} />
        <p className="mt-2 max-w-xl text-[0.9375rem] text-muted-foreground">
          Everyone here can use the workspace&apos;s data connections. Admins manage people; editors build apps and manage
          connections; viewers only open what&apos;s shared with them.
        </p>
      </header>

      {admin && (
        <section aria-labelledby="add-people" className="mb-10">
          <SectionLabel id="add-people">Add people</SectionLabel>
          <InviteForm orgId={org.id} />
          <p className="mt-2 text-xs text-muted-foreground">
            There&apos;s nothing to accept: they&apos;re in the workspace as soon as they sign in with that email. We don&apos;t send an
            email, so let them know.
          </p>
        </section>
      )}

      <section aria-labelledby="members">
        <SectionLabel id="members">Members</SectionLabel>
        <ul className="divide-y rounded-xl border">
          {org.members.map((entry) => (
            <MemberRow
              key={entry.userId}
              orgId={org.id}
              member={{ userId: entry.userId, email: entry.email, role: entry.role, you: entry.you }}
              canManage={admin}
              // A workspace always keeps an admin: the last one can't be demoted.
              lastAdmin={entry.role === "admin" && admins <= 1}
            />
          ))}
        </ul>
      </section>

      {org.invites.length > 0 && (
        <section aria-labelledby="pending" className="mt-10">
          <SectionLabel id="pending">Waiting to sign in</SectionLabel>
          <ul className="divide-y rounded-xl border">
            {org.invites.map((invite) => (
              <PendingInviteRow key={invite.email} orgId={org.id} invite={{ email: invite.email, role: invite.role }} canManage={admin} />
            ))}
          </ul>
        </section>
      )}

      <div className="mt-10 flex justify-end gap-2">
        <LeaveWorkspaceButton orgId={org.id} name={org.name} />
        {admin && <DeleteWorkspaceButton orgId={org.id} name={org.name} />}
      </div>
    </>
  );
}

function MembersSkeleton() {
  return (
    <div aria-busy>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-3 h-4 w-80" />
      <Skeleton className="mt-10 h-[4.25rem] w-full rounded-xl" />
    </div>
  );
}
