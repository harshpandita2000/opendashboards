import { CurrentOrgSwitcher } from "./sidebar-user";

export { AvatarCircle, initialsFor } from "./avatar-circle";

/** The compact avatar for the mobile top bar, with the team menu. Reads the request, so it renders behind Suspense. */
export function UserAvatar() {
  return <CurrentOrgSwitcher compact />;
}

export function UserAvatarFallback() {
  return <span className="size-8 rounded-full bg-neutral-200" aria-hidden />;
}
