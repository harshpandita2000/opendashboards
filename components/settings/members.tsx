"use client";

import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  changeMemberRoleAction,
  deleteOrgAction,
  inviteMemberAction,
  leaveOrgAction,
  removeMemberAction,
  renameOrgAction,
  revokeInviteAction,
} from "@/app/(app)/settings/actions";
import { removeAppGuestAction } from "@/app/(app)/apps/actions";
import { InlineRename } from "@/components/inline-rename";
import { AvatarCircle } from "@/components/shell/avatar-circle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { OrgRole } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

const ROLES: { value: OrgRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
];

const roleLabel = (role: OrgRole) => ROLES.find((entry) => entry.value === role)!.label;

function RoleSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: OrgRole;
  onChange: (role: OrgRole) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as OrgRole)}
      className={cn(
        "h-8 rounded-md border bg-background px-2 text-sm",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
      )}
    >
      {ROLES.map((role) => (
        <option key={role.value} value={role.value}>
          {role.label}
        </option>
      ))}
    </select>
  );
}

/** The workspace's name as the page title. An admin clicks it to rename it. */
export function WorkspaceName({ orgId, name, editable }: { orgId: string; name: string; editable: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [shown, setShown] = useState(name);
  const heading = "text-[1.75rem] leading-tight font-bold tracking-tight";
  if (!editable) return <h1 className={heading}>{name}</h1>;
  if (renaming) {
    return (
      <h1>
        <InlineRename
          value={shown}
          label="Workspace name"
          maxLength={60}
          onSave={(next) => renameOrgAction({ orgId, name: next })}
          onDone={(next) => {
            setShown(next);
            setRenaming(false);
          }}
          className={cn(heading, "h-10 w-full")}
        />
      </h1>
    );
  }
  return (
    <h1>
      <button
        type="button"
        onClick={() => setRenaming(true)}
        title="Rename"
        className={cn(
          heading,
          "-mx-1.5 cursor-text rounded-md px-1.5 text-left hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        )}
      >
        {shown}
      </button>
    </h1>
  );
}

/** Adds someone by email. Nothing is sent and nothing is accepted: they're a member on their next sign-in. */
export function InviteForm({ orgId }: { orgId: string }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await inviteMemberAction({ orgId, email, role });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      toast.success(
        result.data.status === "added"
          ? `${email.trim()} is now in the workspace`
          : `${email.trim()} will join the first time they sign in`,
      );
      setEmail("");
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          aria-label="Email"
          placeholder="name@company.com"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          className="h-8 min-w-48 flex-1"
        />
        <RoleSelect value={role} onChange={setRole} label="Role" />
        <Button type="submit" size="sm" disabled={pending || !email.trim()}>
          {pending ? "Adding…" : "Add"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function MemberRow({
  orgId,
  member,
  canManage,
  lastAdmin,
}: {
  orgId: string;
  member: { userId: string; email: string | null; role: OrgRole; you: boolean };
  canManage: boolean;
  lastAdmin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const name = member.email ?? "Someone who hasn't signed in lately";

  function changeRole(role: OrgRole) {
    startTransition(async () => {
      const result = await changeMemberRoleAction({ orgId, userId: member.userId, role });
      if (!result.ok) toast.error(result.error.message);
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await removeMemberAction({ orgId, userId: member.userId });
      if (!result.ok) toast.error(result.error.message);
      else toast.success(`${name} was removed`);
    });
  }

  return (
    <li className="flex items-center gap-3 p-3.5">
      <AvatarCircle name={member.email ?? "?"} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {name}
          {member.you && <span className="ml-1.5 font-normal text-muted-foreground">(you)</span>}
        </p>
      </div>
      {pending && <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden />}
      {canManage ? (
        <RoleSelect value={member.role} onChange={changeRole} disabled={pending || lastAdmin} label={`Role of ${name}`} />
      ) : (
        <span className="text-sm text-muted-foreground">{roleLabel(member.role)}</span>
      )}
      {canManage && !member.you && (
        <>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)} disabled={pending}>
            Remove
          </Button>
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  They lose access to this workspace straight away. Their apps stay in it, and connections they added keep
                  working.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={remove}>
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </li>
  );
}

export function PendingInviteRow({
  orgId,
  invite,
  canManage,
}: {
  orgId: string;
  invite: { email: string; role: OrgRole };
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  function revoke() {
    startTransition(async () => {
      const result = await revokeInviteAction({ orgId, email: invite.email });
      if (!result.ok) toast.error(result.error.message);
    });
  }
  return (
    <li className="flex items-center gap-3 p-3.5">
      <AvatarCircle name={invite.email} className="bg-neutral-100 text-neutral-500" />
      <p className="min-w-0 flex-1 truncate text-sm">{invite.email}</p>
      <span className="text-sm text-muted-foreground">{roleLabel(invite.role)}</span>
      {canManage && (
        <Button variant="ghost" size="sm" onClick={revoke} disabled={pending}>
          Cancel
        </Button>
      )}
    </li>
  );
}

/** One guest of one app, for the workspace's admins: who, on which app, let in by whom. */
export function GuestRow({ guest }: { guest: { appId: string; appName: string; email: string; invitedBy: string | null } }) {
  const [pending, startTransition] = useTransition();
  function remove() {
    startTransition(async () => {
      const result = await removeAppGuestAction({ id: guest.appId, email: guest.email });
      if (!result.ok) toast.error(result.error.message);
      else toast.success(`${guest.email} can no longer view ${guest.appName}`);
    });
  }
  return (
    <li className="flex items-center gap-3 p-3.5">
      <AvatarCircle name={guest.email} className="bg-neutral-100 text-neutral-500" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{guest.email}</p>
        <p className="truncate text-sm text-muted-foreground">
          Can view {guest.appName}
          {guest.invitedBy ? ` · added by ${guest.invitedBy}` : ""}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={remove} disabled={pending}>
        Remove
      </Button>
    </li>
  );
}

/**
 * Deletes the workspace and everything in it, for everyone. Admins only, and
 * only once its name is typed out: there is no undo.
 */
export function DeleteWorkspaceButton({ orgId, name }: { orgId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const matches = typed.trim() === name;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!matches) return;
    startTransition(async () => {
      // On success the action leaves for another workspace, or the screen to create one.
      const result = await deleteOrgAction({ orgId, name: typed });
      if (result && !result.ok) setError(result.error.message);
    });
  }

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Delete workspace
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          if (!next) {
            setTyped("");
            setError(null);
          }
          setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle>Delete {name}?</DialogTitle>
              <DialogDescription>
                This deletes the workspace for everyone in it: every member&apos;s apps and dashboards, all its data connections
                and their stored credentials, and its member list. It can&apos;t be undone.
              </DialogDescription>
            </DialogHeader>
            <Field className="my-6" data-invalid={!!error || undefined}>
              <FieldLabel htmlFor="delete-workspace-name">
                Type <span className="font-semibold">{name}</span> to confirm
              </FieldLabel>
              <Input
                id="delete-workspace-name"
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setError(null);
                }}
                autoComplete="off"
                autoFocus
                aria-invalid={!!error || undefined}
              />
              <FieldError>{error}</FieldError>
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={!matches || pending}>
                {pending && <Loader2Icon className="animate-spin" aria-hidden />}
                Delete workspace
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LeaveWorkspaceButton({ orgId, name }: { orgId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  function leave() {
    startTransition(async () => {
      const result = await leaveOrgAction({ orgId });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      router.push("/apps");
    });
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={pending}>
        Leave workspace
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              You lose access to its apps and data connections. Apps you made here stay in it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={leave}>
              Leave workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
