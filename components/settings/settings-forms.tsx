"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  addModelProviderAction,
  changeRoleAction,
  createOrgAction,
  deleteModelProviderAction,
  deleteOrgAction,
  inviteAction,
  leaveOrgAction,
  removeMemberAction,
  renameOrgAction,
  retestModelProviderAction,
  revokeInviteAction,
  setDefaultModelProviderAction,
  setMcpAllowedToolsAction,
  switchOrgAction,
  updateOrgSettingsAction,
} from "@/app/(app)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/*
 * The organisation settings page's forms. Every action checks the user's role
 * on the server; these only hide what a role can't do.
 */

type ActionResult = { ok: true; data?: unknown } | { ok: false; error: { message: string; field?: string } };

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";
const textareaClass =
  "min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none";

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult | undefined | void>, success?: string, after?: (result: ActionResult) => void) =>
    start(async () => {
      setError(null);
      const result = await fn();
      if (!result) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (success) toast.success(success);
      after?.(result);
    });
  return { pending, error, run };
}

export function OrgSwitcher({ current, orgs }: { current: string; orgs: { id: string; name: string; role: string }[] }) {
  const { pending, error, run } = useAction();
  return (
    <Field>
      <FieldLabel htmlFor="org-switch">Organisation</FieldLabel>
      <select
        id="org-switch"
        className={selectClass}
        value={current}
        disabled={pending}
        onChange={(event) => run(() => switchOrgAction(event.target.value))}
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name} ({org.role})
          </option>
        ))}
      </select>
      {error && <FieldError>{error}</FieldError>}
    </Field>
  );
}

export function CreateOrgForm() {
  const [name, setName] = useState("");
  const { pending, error, run } = useAction();
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(() => createOrgAction({ name }));
      }}
    >
      <Field className="flex-1">
        <FieldLabel htmlFor="org-new">New team organisation</FieldLabel>
        <Input id="org-new" value={name} onChange={(event) => setName(event.target.value)} placeholder="Acme Analytics" maxLength={80} />
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending || !name.trim()}>
        Create
      </Button>
    </form>
  );
}

export function OrgGeneralForm({ name: initial, canEdit, canDelete, canLeave }: { name: string; canEdit: boolean; canDelete: boolean; canLeave: boolean }) {
  const [name, setName] = useState(initial);
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-3">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => renameOrgAction({ name }), "Renamed");
        }}
      >
        <Field className="flex-1">
          <FieldLabel htmlFor="org-name">Name</FieldLabel>
          <Input id="org-name" value={name} disabled={!canEdit} onChange={(event) => setName(event.target.value)} maxLength={80} />
        </Field>
        {canEdit && (
          <Button type="submit" variant="outline" disabled={pending || name.trim() === initial}>
            Save
          </Button>
        )}
      </form>
      <div className="flex gap-2">
        {canLeave && (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => confirm("Leave this organisation?") && run(() => leaveOrgAction())}>
            Leave organisation
          </Button>
        )}
        {canDelete && (
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() => confirm("Delete this organisation and everything in it? This can't be undone.") && run(() => deleteOrgAction())}
          >
            Delete organisation
          </Button>
        )}
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

type Member = { userId: string; email: string; role: string };

export function MembersList({ members, me, canManage, roles }: { members: Member[]; me: string; canManage: boolean; roles: string[] }) {
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border">
        {members.map((member) => (
          <li key={member.userId} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {member.email || member.userId}
              {member.userId === me && <span className="text-muted-foreground"> (you)</span>}
            </span>
            {canManage && member.role !== "owner" && member.userId !== me ? (
              <>
                <select
                  aria-label={`Role for ${member.email}`}
                  className={`${selectClass} w-32`}
                  value={member.role}
                  disabled={pending}
                  onChange={(event) => run(() => changeRoleAction({ userId: member.userId, role: event.target.value }), "Role changed")}
                >
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => removeMemberAction(member.userId), "Removed")}>
                  Remove
                </Button>
              </>
            ) : (
              <Badge variant="secondary">{member.role}</Badge>
            )}
          </li>
        ))}
      </ul>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

type Invite = { id: string; email: string; role: string; expiresAt: string };

export function InvitePanel({ invites, roles }: { invites: Invite[]; roles: string[] }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [link, setLink] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => inviteAction({ email, role }), "Invitation created", (result) => {
            if (result.ok) setLink((result.data as { link: string }).link);
            setEmail("");
          });
        }}
      >
        <Field className="min-w-56 flex-1">
          <FieldLabel htmlFor="invite-email">Invite by email</FieldLabel>
          <Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teammate@company.com" />
        </Field>
        <Field className="w-32">
          <FieldLabel htmlFor="invite-role">Role</FieldLabel>
          <select id="invite-role" className={selectClass} value={role} onChange={(event) => setRole(event.target.value)}>
            {roles.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" disabled={pending || !email.trim()}>
          Invite
        </Button>
      </form>
      {error && <FieldError>{error}</FieldError>}
      {link && (
        <div className="rounded-md border bg-neutral-50 p-3 text-sm">
          <p className="mb-1 font-medium">Send this link to them. It works once, for that email address, for 7 days, and isn&apos;t shown again.</p>
          <code className="block break-all text-xs">{link}</code>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success("Copied"))}>
            Copy link
          </Button>
        </div>
      )}
      {invites.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {invites.map((invite) => (
            <li key={invite.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{invite.email}</span>
              <Badge variant="outline">{invite.role}</Badge>
              <span className="text-xs text-muted-foreground">until {new Date(invite.expiresAt).toLocaleDateString()}</span>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => revokeInviteAction(invite.id), "Revoked")}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Provider = {
  id: string;
  name: string;
  endpoint: string;
  deployment: string;
  apiVersion: string;
  authMode: string;
  credentialHint: string;
  isDefault: boolean;
  status: string;
  lastError: string | null;
};

export function ModelProviders({ providers }: { providers: Provider[] }) {
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-3">
      {providers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None yet: the Build agent uses OpenDashboards&apos; default model. Add your Azure OpenAI deployment to use your own.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {providers.map((provider) => (
            <li key={provider.id} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{provider.name}</span>
                {provider.isDefault && <Badge>In use</Badge>}
                <Badge variant={provider.status === "ok" ? "secondary" : "destructive"}>{provider.status}</Badge>
                <span className="ml-auto flex gap-1">
                  {!provider.isDefault && (
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setDefaultModelProviderAction(provider.id), "Now in use")}>
                      Use
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => retestModelProviderAction(provider.id), "Checked")}>
                    Test
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => confirm(`Delete ${provider.name}?`) && run(() => deleteModelProviderAction(provider.id), "Deleted")}
                  >
                    Delete
                  </Button>
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {provider.endpoint} · {provider.deployment} · {provider.apiVersion} · {provider.authMode === "api_key" ? "API key" : "Entra ID"}{" "}
                {provider.credentialHint}
              </p>
              {provider.lastError && <p className="text-xs text-amber-700">{provider.lastError}</p>}
            </li>
          ))}
          {providers.some((provider) => provider.isDefault) && (
            <li className="px-3 py-2">
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setDefaultModelProviderAction(null), "Using the default model")}>
                Go back to OpenDashboards&apos; default model
              </Button>
            </li>
          )}
        </ul>
      )}
      {error && <FieldError>{error}</FieldError>}
      <AddModelProvider />
    </div>
  );
}

const EMPTY_PROVIDER = {
  name: "",
  endpoint: "",
  deployment: "",
  apiVersion: "2025-04-01-preview",
  authMode: "api_key",
  tenantId: "",
  clientId: "",
  credential: "",
  reasoningEffort: "",
};

function AddModelProvider() {
  const [values, setValues] = useState(EMPTY_PROVIDER);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof EMPTY_PROVIDER) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));
  const entra = values.authMode === "entra_client_credentials";

  function submit(event: React.FormEvent) {
    event.preventDefault();
    start(async () => {
      setFieldError(null);
      const result = await addModelProviderAction({
        name: values.name,
        credential: values.credential,
        makeDefault: true,
        config: {
          kind: "azure_openai",
          endpoint: values.endpoint,
          deployment: values.deployment,
          apiVersion: values.apiVersion,
          authMode: values.authMode,
          ...(entra ? { tenantId: values.tenantId, clientId: values.clientId } : {}),
          ...(values.reasoningEffort ? { reasoningEffort: values.reasoningEffort } : {}),
        },
      });
      if (!result.ok) {
        setFieldError({ field: result.error.field, message: result.error.message });
        return;
      }
      toast.success(result.data.warning ? `Saved. ${result.data.warning}` : "Connected and in use");
      setValues(EMPTY_PROVIDER);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">Add an Azure OpenAI deployment</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="mp-name">Name</FieldLabel>
          <Input id="mp-name" value={values.name} onChange={set("name")} placeholder="EY Foundry gpt-4.1" />
        </Field>
        <Field>
          <FieldLabel htmlFor="mp-endpoint">Endpoint</FieldLabel>
          <Input id="mp-endpoint" value={values.endpoint} onChange={set("endpoint")} placeholder="https://my-resource.openai.azure.com/" />
        </Field>
        <Field>
          <FieldLabel htmlFor="mp-deployment">Deployment</FieldLabel>
          <Input id="mp-deployment" value={values.deployment} onChange={set("deployment")} placeholder="gpt-4.1" />
          <FieldDescription>It must support tool calling.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="mp-version">API version</FieldLabel>
          <Input id="mp-version" value={values.apiVersion} onChange={set("apiVersion")} />
        </Field>
        <Field>
          <FieldLabel htmlFor="mp-auth">Authentication</FieldLabel>
          <select id="mp-auth" className={selectClass} value={values.authMode} onChange={set("authMode")}>
            <option value="api_key">API key</option>
            <option value="entra_client_credentials">Entra ID app (client credentials)</option>
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor="mp-effort">Reasoning effort (reasoning models)</FieldLabel>
          <select id="mp-effort" className={selectClass} value={values.reasoningEffort} onChange={set("reasoningEffort")}>
            <option value="">Model default</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
        {entra && (
          <>
            <Field>
              <FieldLabel htmlFor="mp-tenant">Directory (tenant) ID</FieldLabel>
              <Input id="mp-tenant" value={values.tenantId} onChange={set("tenantId")} />
            </Field>
            <Field>
              <FieldLabel htmlFor="mp-client">Application (client) ID</FieldLabel>
              <Input id="mp-client" value={values.clientId} onChange={set("clientId")} />
            </Field>
          </>
        )}
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="mp-credential">{entra ? "Client secret" : "API key"}</FieldLabel>
          <Input id="mp-credential" type="password" autoComplete="off" value={values.credential} onChange={set("credential")} />
          <FieldDescription>Encrypted before it&apos;s stored; only the last four characters are ever shown.</FieldDescription>
        </Field>
      </div>
      {fieldError && <FieldError>{fieldError.message}</FieldError>}
      <Button type="submit" disabled={pending}>
        {pending ? "Testing…" : "Test & save"}
      </Button>
    </form>
  );
}

export function McpPolicy({ allowedHosts, servers }: { allowedHosts: string[] | null; servers: { id: string; name: string; host: string; allowedTools: string[] | null }[] }) {
  const [hosts, setHosts] = useState((allowedHosts ?? []).join("\n"));
  const [restrictHosts, setRestrictHosts] = useState(allowedHosts !== null);
  const { pending, error, run } = useAction();
  return (
    <div className="space-y-4">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const list = hosts.split(/[\s,]+/).map((host) => host.trim()).filter(Boolean);
          run(() => updateOrgSettingsAction({ mcpAllowedHosts: restrictHosts ? list : null }), "Saved");
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={restrictHosts} onChange={(event) => setRestrictHosts(event.target.checked)} />
          Only allow MCP servers on these hosts
        </label>
        {restrictHosts && (
          <textarea
            aria-label="Allowed MCP hosts"
            className={textareaClass}
            value={hosts}
            onChange={(event) => setHosts(event.target.value)}
            placeholder={"mcp.example.com\n*.internal-tools.com"}
          />
        )}
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          Save hosts
        </Button>
      </form>
      {servers.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {servers.map((server) => (
            <McpServerTools key={server.id} server={server} />
          ))}
        </ul>
      )}
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

function McpServerTools({ server }: { server: { id: string; name: string; host: string; allowedTools: string[] | null } }) {
  const [restrict, setRestrict] = useState(server.allowedTools !== null);
  const [tools, setTools] = useState((server.allowedTools ?? []).join("\n"));
  const { pending, error, run } = useAction();
  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <p>
        <span className="font-medium">{server.name}</span> <span className="text-muted-foreground">{server.host}</span>
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={restrict} onChange={(event) => setRestrict(event.target.checked)} />
        Only these tools (otherwise every tool the server marks read-only)
      </label>
      {restrict && (
        <textarea aria-label={`Allowed tools for ${server.name}`} className={textareaClass} value={tools} onChange={(event) => setTools(event.target.value)} placeholder="list_invoices" />
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          run(
            () => setMcpAllowedToolsAction({ id: server.id, allowedTools: restrict ? tools.split(/[\s,]+/).map((tool) => tool.trim()).filter(Boolean) : null }),
            "Saved",
          )
        }
      >
        Save tools
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </li>
  );
}
