"use client";

import { Loader2Icon, LockIcon, PencilIcon, EyeIcon, UsersIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { setAppTeamAccessAction } from "@/app/(app)/apps/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AppTeamAccess } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

type App = { id: string; name: string; teamAccess: AppTeamAccess };

const OPTIONS: { value: AppTeamAccess; label: string; icon: typeof LockIcon; detail: (workspace: string) => string }[] = [
  { value: "private", label: "Private", icon: LockIcon, detail: () => "Only its owner can open it." },
  { value: "view", label: "Workspace can view", icon: EyeIcon, detail: (workspace) => `Everyone in ${workspace} can open it.` },
  {
    value: "edit",
    label: "Workspace can edit",
    icon: PencilIcon,
    detail: (workspace) => `Everyone in ${workspace} can open it; editors and admins can build in it.`,
  },
];

/**
 * Who else in the workspace can open the app, set like a shared document:
 * nobody, everyone to view, or everyone to edit. Its dashboards follow.
 */
export function ShareApp({
  app,
  workspace,
  personalConnections,
}: {
  app: App;
  /** The workspace's name. */
  workspace: string;
  /** How many of the app's connections are personal sign-ins: others can't query through them. */
  personalConnections: number;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<AppTeamAccess>(app.teamAccess);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const result = await setAppTeamAccessAction({ id: app.id, teamAccess: choice });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      toast.success(choice === "private" ? `${app.name} is private` : `${app.name} is shared with ${workspace}`);
      setOpen(false);
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {app.teamAccess === "private" ? <LockIcon aria-hidden /> : <UsersIcon aria-hidden />}
        Share
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          if (next) {
            setChoice(app.teamAccess);
            setError(null);
          }
          setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share {app.name}</DialogTitle>
            <DialogDescription>Its dashboards are shared with it. Chats stay your own.</DialogDescription>
          </DialogHeader>
          <div role="radiogroup" aria-label="Who can open this app" className="my-4 space-y-2">
            {OPTIONS.map(({ value, label, icon: Icon, detail }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={choice === value}
                onClick={() => {
                  setChoice(value);
                  setError(null);
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  choice === value ? "border-foreground/40 bg-neutral-50" : "hover:bg-neutral-50/60",
                )}
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-sm text-muted-foreground">{detail(workspace)}</span>
                </span>
              </button>
            ))}
          </div>
          {choice !== "private" && (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>Only share with people you trust.</p>
              {personalConnections > 0 && (
                <p>
                  This app uses {personalConnections === 1 ? "1 connection" : `${personalConnections} connections`} only you can
                  query. Others will be asked to sign in.
                </p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            {/* Saving the same choice again is allowed: it shares any dashboard that isn't shared yet. */}
            <Button onClick={save} disabled={pending || (choice === "private" && app.teamAccess === "private")}>
              {pending && <Loader2Icon className="animate-spin" aria-hidden />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
