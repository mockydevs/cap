"use client";
import { useEffect, useState } from "react";

export function AcceptInvitation() {
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
      const acceptResponse = await fetch(
        "/api/workspace/invitations/accept",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
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
      await fetch("/api/auth/session/switch-workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      setStatus("done");
      window.location.assign("/library");
    })();
  }, []);

  if (status === "unauthenticated")
    return (
      <p className="hint">
        <a href="/login">Log in</a> or <a href="/signup">create an account</a>{" "}
        with the invited email, then open this invitation link again.
      </p>
    );
  if (status === "error")
    return (
      <p className="form-error" role="alert">
        This invitation link is invalid, expired, or already used.
      </p>
    );
  return <p className="hint">Joining the workspace…</p>;
}
