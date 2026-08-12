"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { sendJson } from "../lib/http/json";

export function AcceptInvitation() {
  const router = useRouter();
  const [status, setStatus] = useState<
    "pending" | "done" | "error" | "unauthenticated"
  >("pending");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setStatus("error");
      return;
    }
    void (async () => {
      const acceptResponse = await sendJson(
        "/api/workspace/invitations/accept",
        "POST",
        { token },
      );
      if (acceptResponse.status === 401) {
        setStatus("unauthenticated");
        return;
      }
      if (!acceptResponse.ok) {
        setStatus("error");
        return;
      }
      const { workspaceId } = (await acceptResponse.json()) as {
        workspaceId: string;
      };
      await sendJson("/api/auth/session/switch-workspace", "POST", {
        workspaceId,
      });
      setStatus("done");
      router.replace("/library");
    })();
  }, [router]);

  return (
    <section className="invite-shell">
      <header className="invite-header">
        <Link className="brand" href="/"><span className="brand-mark" />cap</Link>
        <span>Workspace invitation</span>
      </header>
      <div className="invite-card" aria-live="polite">
        <div className={`invite-state-icon invite-state-${status}`} aria-hidden="true">
          {status === "pending" ? "…" : status === "error" ? "!" : status === "unauthenticated" ? "→" : "✓"}
        </div>
        {status === "pending" && (
          <>
            <p className="eyebrow">Checking invitation</p>
            <h1>Joining your workspace.</h1>
            <p>We&apos;re validating the invitation and preparing your access.</p>
            <div className="invite-progress"><span /></div>
          </>
        )}
        {status === "done" && (
          <>
            <p className="eyebrow">Access confirmed</p>
            <h1>You&apos;re in.</h1>
            <p>Taking you to the workspace library now.</p>
          </>
        )}
        {status === "unauthenticated" && (
          <>
            <p className="eyebrow">Account required</p>
            <h1>Sign in to accept.</h1>
            <p>Use the invited email address, then reopen this invitation link.</p>
            <div className="invite-actions">
              <Link className="marketing-primary" href="/login">Sign in</Link>
              <Link className="marketing-secondary" href="/signup">Create account</Link>
            </div>
          </>
        )}
        {status === "error" && (
          <>
            <p className="eyebrow">Invitation unavailable</p>
            <h1>This link can&apos;t be used.</h1>
            <p role="alert">It may be invalid, expired, or already accepted. Ask the workspace administrator for a new invitation.</p>
            <Link className="marketing-primary" href="/">Return home</Link>
          </>
        )}
      </div>
      <footer className="invite-footer">
        <span>Private by default</span><span>Secure workspace access</span>
      </footer>
    </section>
  );
}
