"use client";

import { CheckIcon, EyeIcon, LinkIcon, Loader2Icon, LockIcon, PencilIcon, UsersIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { addAppGuestAction, removeAppGuestAction, setAppTeamAccessAction } from "@/app/(app)/apps/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { appPath } from "@/lib/apps/paths";
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
  guests,
  dashboardCount,
}: {
  app: App;
  /** The workspace's name. */
  workspace: string;
  /** How many of the app's connections are personal sign-ins: others can't query through them. */
  personalConnections: number;
  /** People outside the workspace who may view the app, by email. */
  guests: string[];
  /** How many dashboards the app has: its first one is the moment to suggest sharing. */
  dashboardCount: number;
}) {
  const [open, setOpen] = useState(false);
  const nudge = useShareNudge(app.id, dashboardCount);
  // Nothing to suggest once it's shared.
  const showNudge = nudge.pending && !open && app.teamAccess === "private" && !guests.length;
  const [choice, setChoice] = useState<AppTeamAccess>(app.teamAccess);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openDialog(next: boolean) {
    if (pending) return;
    if (next) {
      setChoice(app.teamAccess);
      setError(null);
      // Opening Share answers the suggestion.
      nudge.dismiss();
    }
    setOpen(next);
  }

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
      <div className="relative">
        <Button variant="outline" size="sm" onClick={() => openDialog(true)}>
          {app.teamAccess === "private" && !guests.length ? <LockIcon aria-hidden /> : <UsersIcon aria-hidden />}
          Share
        </Button>
        {showNudge && (
          <div
            role="status"
            className="absolute top-full right-0 z-30 mt-2 w-64 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            {/* Points at the Share button above. */}
            <span aria-hidden className="absolute -top-1.5 right-6 size-3 rotate-45 border-t border-l bg-popover" />
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-sm">Your dashboard is ready. Share it with your team or a client.</p>
              <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={nudge.dismiss} className="-mt-1 -mr-1">
                <XIcon aria-hidden />
              </Button>
            </div>
            <Button size="sm" className="mt-2" onClick={() => openDialog(true)}>
              Share
            </Button>
          </div>
        )}
      </div>
      <Dialog open={open} onOpenChange={openDialog}>
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
          <Guests appId={app.id} guests={guests} blocked={personalConnections > 0} />
          <DialogFooter>
            <CopyLink appId={app.id} />
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

/*
 * The suggestion to share, made when an app gets its first dashboard. It's
 * kept in this browser: "pending" from that moment until it's dismissed or
 * Share is opened, so it survives a reload and never comes back for that app.
 */
const nudgeKey = (appId: string) => `opendashboards:share-nudge:${appId}`;
const nudgeListeners = new Set<() => void>();

function readNudge(appId: string) {
  try {
    return window.localStorage.getItem(nudgeKey(appId));
  } catch {
    return null;
  }
}

function writeNudge(appId: string, value: "pending" | "done") {
  try {
    window.localStorage.setItem(nudgeKey(appId), value);
  } catch {
    // Without storage the suggestion just doesn't show.
  }
  nudgeListeners.forEach((listener) => listener());
}

function subscribeNudge(listener: () => void) {
  nudgeListeners.add(listener);
  return () => void nudgeListeners.delete(listener);
}

function useShareNudge(appId: string, dashboardCount: number) {
  const state = useSyncExternalStore(
    subscribeNudge,
    () => readNudge(appId),
    () => null,
  );
  // The first dashboard arriving while the app is open is the moment.
  const before = useRef(dashboardCount);
  useEffect(() => {
    if (before.current === 0 && dashboardCount > 0 && readNudge(appId) === null) writeNudge(appId, "pending");
    before.current = dashboardCount;
  }, [appId, dashboardCount]);

  return { pending: state === "pending", dismiss: () => state === "pending" && writeNudge(appId, "done") };
}

/**
 * People outside the workspace who may view the app: the whole app, read-only,
 * and nothing else of the workspace. Added and removed straight away, apart
 * from the choice above.
 */
function Guests({ appId, guests, blocked }: { appId: string; guests: string[]; blocked: boolean }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function add(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await addAppGuestAction({ id: appId, email });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      toast.success(`${email.trim()} can view this app once they sign in with that email`);
      setEmail("");
    });
  }

  function remove(guest: string) {
    startTransition(async () => {
      const result = await removeAppGuestAction({ id: appId, email: guest });
      if (!result.ok) toast.error(result.error.message);
    });
  }

  return (
    <section aria-labelledby="share-guests" className="mt-5 border-t pt-4">
      <h3 id="share-guests" className="text-sm font-medium">
        People outside the workspace
      </h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        They can view this app and nothing else. Only share with people you trust.
      </p>
      {blocked ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Guests can&apos;t be added while this app uses a personal sign-in: they couldn&apos;t query through it.
        </p>
      ) : (
        <form onSubmit={add} className="mt-3 flex items-center gap-2">
          <Input
            type="email"
            aria-label="Guest's email"
            placeholder="name@company.com"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            className="h-8 flex-1"
          />
          <Button type="submit" size="sm" variant="outline" disabled={pending || !email.trim()}>
            {pending ? <Loader2Icon className="animate-spin" aria-hidden /> : null}
            Add
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {guests.length > 0 && (
        <ul className="mt-3 divide-y rounded-lg border">
          {guests.map((guest) => (
            <li key={guest} className="flex items-center gap-2 py-1.5 pr-1.5 pl-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{guest}</span>
              <span className="text-xs text-muted-foreground">Can view</span>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${guest}`} onClick={() => remove(guest)} disabled={pending}>
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Copies the app's link, to send to whoever it's shared with. The link opens
 * for nobody else: they still have to sign in as someone who's been let in.
 */
function CopyLink({ appId }: { appId: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(new URL(appPath(appId), window.location.origin).href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy the link. Copy it from the address bar instead.");
    }
  }

  return (
    <Button type="button" variant="ghost" onClick={copy} className="sm:mr-auto">
      {copied ? <CheckIcon aria-hidden /> : <LinkIcon aria-hidden />}
      {copied ? "Link copied" : "Copy link"}
    </Button>
  );
}
