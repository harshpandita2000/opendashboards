"use client";

import { CheckIcon, ChevronsUpDownIcon, PlusIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { createOrgAction, switchDevUserAction, switchOrgAction } from "@/app/(app)/settings/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { AvatarCircle } from "./avatar-circle";

export type SwitcherOrg = { id: string; name: string; isNew: boolean };

/**
 * Who is signed in and which workspace they have open, with the menu to switch
 * to another, create one, or manage the open one. `compact` is the avatar
 * alone, for the mobile top bar.
 */
export function OrgSwitcher({
  email,
  orgs,
  activeId,
  compact = false,
  devUsers,
}: {
  email: string;
  orgs: SwitcherOrg[];
  activeId: string;
  compact?: boolean;
  /** Local development only: stand-in people to act as. */
  devUsers?: readonly string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const active = orgs.find((org) => org.id === activeId);
  const hasNew = orgs.some((org) => org.isNew);

  function open(orgId: string) {
    if (orgId === activeId) return;
    startTransition(async () => {
      const result = await switchOrgAction(orgId);
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      // Whatever was on screen belonged to the org just left.
      router.push("/apps");
    });
  }

  function actAs(name: string | null) {
    startTransition(async () => {
      await switchDevUserAction(name);
      // A full load, on purpose: everything on screen, the sidebar included, was rendered for the previous person.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/apps");
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {compact ? (
            <button
              type="button"
              aria-label={`Signed in as ${email}. Switch workspace`}
              className="relative rounded-full focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <AvatarCircle name={email} />
              {hasNew && <NewDot className="absolute -top-0.5 -right-0.5" />}
            </button>
          ) : (
            <button
              type="button"
              aria-label={`Signed in as ${email}, in ${active?.name ?? "a workspace"}. Switch workspace`}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.04]",
                "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                pending && "opacity-60",
              )}
            >
              <span className="relative">
                <AvatarCircle name={email} className="size-7" />
                {hasNew && <NewDot className="absolute -top-0.5 -right-0.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground/90">{active?.name}</span>
                <span className="block truncate text-xs text-muted-foreground" title={email}>
                  {email}
                </span>
              </span>
              <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={compact ? "end" : "start"} side={compact ? "bottom" : "top"} className="w-60">
          <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{email}</DropdownMenuLabel>
          {orgs.map((org) => (
            <DropdownMenuItem key={org.id} onSelect={() => open(org.id)} disabled={pending}>
              <span className="min-w-0 flex-1 truncate">{org.name}</span>
              {org.isNew && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[0.6875rem] font-medium text-blue-700">New</span>}
              {org.id === activeId && <CheckIcon aria-label="Open now" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <UsersIcon aria-hidden />
              Workspace settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <PlusIcon aria-hidden />
            Create a workspace
          </DropdownMenuItem>
          {devUsers && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Local only: act as</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => actAs(null)} disabled={pending}>
                The dev user
              </DropdownMenuItem>
              {devUsers.map((name) => (
                <DropdownMenuItem key={name} onSelect={() => actAs(name)} disabled={pending}>
                  {name}@example.dev
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

function NewDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("size-2 rounded-full bg-blue-600 ring-2 ring-neutral-50", className)} />;
}

/** Names a new workspace. Its creator is its first admin, and it opens straight away. */
export function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createOrgAction({ name });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      setName("");
      router.push("/settings");
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Create a workspace</DialogTitle>
            <DialogDescription>
              A workspace has its own apps, data connections and members. Your other workspaces stay as they are.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
            <Input
              id="workspace-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              maxLength={60}
              placeholder="Acme"
              autoFocus
              aria-invalid={error ? true : undefined}
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
