"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type SessionView = {
  user: { displayName: string; email: string };
  workspace: { role: string };
};
export function UserNav() {
  const [session, setSession] = useState<SessionView | null | undefined>();
  useEffect(() => {
    fetch("/api/auth/session")
      .then(async (response) =>
        setSession(
          response.ok ? ((await response.json()) as SessionView) : null,
        ),
      )
      .catch(() => setSession(null));
  }, []);
  if (session === undefined)
    return <span className="nav-loading" aria-label="Loading account" />;
  if (!session)
    return (
      <nav className="user-nav">
        <Link href="/login">Sign in</Link>
        <Link className="nav-cta" href="/signup">
          Create account
        </Link>
      </nav>
    );
  const initials = session.user.displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <div className="user-nav">
      <Link href="/record">Record</Link>
      <Link href="/library">Library</Link>
      {(session.workspace.role === "OWNER" ||
        session.workspace.role === "ADMIN") && <Link href="/admin">Admin</Link>}
      <span className="account-pill">
        <span className="account-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="account-copy">
          <strong>{session.user.displayName}</strong>
          <small>{session.workspace.role.toLowerCase()}</small>
        </span>
      </span>
      <form method="post" action="/api/auth/logout">
        <button className="nav-link" type="submit">
          Sign out
        </button>
      </form>
    </div>
  );
}
