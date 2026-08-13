import Link from "next/link";
import { initialsOf } from "../lib/format/display";
import { TranscriptSearch } from "./transcript-search";
import { WorkspaceMark } from "./workspace-mark";

const views = [
  { key: "library", label: "Library", href: "/library" },
  { key: "shared", label: "Shared", href: "/library?view=shared" },
  { key: "starred", label: "Starred", href: "/library?view=starred" },
  { key: "trash", label: "Trash", href: "/library?view=trash" },
] as const;

export type WorkspaceSection =
  (typeof views)[number]["key"] | "record" | "settings" | "none";

export type BarAccount = { displayName: string; role: string };

/**
 * The one bar every signed-in surface wears: identity on the left, the
 * workspace's views in the middle, and the two things you always want to
 * reach — search and recording — on the right.
 */
export function WorkspaceBar({
  current,
  account,
  showSearch = true,
}: {
  current: WorkspaceSection;
  account: BarAccount;
  showSearch?: boolean;
}) {
  const canManageWorkspace =
    account.role === "OWNER" || account.role === "ADMIN";
  return (
    <header className="workspace-bar">
      <WorkspaceMark />
      <nav className="workspace-nav" aria-label="Workspace views">
        {views.map((view) => (
          <Link
            key={view.key}
            href={view.href}
            aria-current={current === view.key ? "page" : undefined}
          >
            {view.label}
          </Link>
        ))}
        {canManageWorkspace && (
          <Link
            href="/admin"
            aria-current={current === "settings" ? "page" : undefined}
          >
            Workspace
          </Link>
        )}
      </nav>
      {showSearch && <TranscriptSearch />}
      <Link
        className="btn workspace-record"
        href="/record"
        aria-current={current === "record" ? "page" : undefined}
      >
        <span className="record-dot" aria-hidden="true" />
        Record
      </Link>
      <details className="account-menu">
        <summary aria-label={`Account: ${account.displayName}`}>
          <span className="avatar" aria-hidden="true">
            {initialsOf(account.displayName)}
          </span>
        </summary>
        <div className="account-menu-panel">
          <span className="account-identity">
            <strong>{account.displayName}</strong>
            <small>{account.role.toLowerCase()}</small>
          </span>
          <Link href="/admin">Workspace settings</Link>
          <form method="post" action="/api/auth/logout">
            <button className="btn btn-secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </details>
    </header>
  );
}
