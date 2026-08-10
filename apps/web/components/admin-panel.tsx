"use client";
import { useCallback, useEffect, useState } from "react";

type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
type Member = {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  joinedAt: string;
};
type Invitation = {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
};
type RetentionPolicy = {
  recordingRetentionDays: number | null;
  deletedRecordingPurgeDays: number;
};
type AuditEvent = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
};

const ROLES: Role[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

export function AdminPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [retention, setRetention] = useState<RetentionPolicy>();
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("MEMBER");
  const [inviteLink, setInviteLink] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [isAdmin, setIsAdmin] = useState(true);

  const refreshMembers = useCallback(async () => {
    const response = await fetch("/api/workspace/members", {
      cache: "no-store",
    });
    if (response.ok)
      setMembers((await response.json() as { items: Member[] }).items);
  }, []);

  const refreshInvitations = useCallback(async () => {
    const response = await fetch("/api/workspace/invitations", {
      cache: "no-store",
    });
    if (response.status === 403) {
      setIsAdmin(false);
      return;
    }
    if (response.ok)
      setInvitations((await response.json() as { items: Invitation[] }).items);
  }, []);

  const refreshRetention = useCallback(async () => {
    const response = await fetch("/api/workspace/retention-policy", {
      cache: "no-store",
    });
    if (response.ok) setRetention(await response.json());
  }, []);

  const loadAuditEvents = useCallback(async (cursor?: string) => {
    const response = await fetch(
      `/api/workspace/audit-events?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const page = (await response.json()) as {
      items: AuditEvent[];
      nextCursor: string | null;
    };
    setAuditEvents((current) =>
      cursor ? [...current, ...page.items] : page.items,
    );
    setAuditCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    void refreshMembers();
    void refreshInvitations();
    void refreshRetention();
    void loadAuditEvents();
  }, [refreshMembers, refreshInvitations, refreshRetention, loadAuditEvents]);

  const inviteMember = async () => {
    setMessage(undefined);
    setInviteLink(undefined);
    const response = await fetch("/api/workspace/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (!response.ok) {
      setMessage("Could not invite that member.");
      return;
    }
    const result = (await response.json()) as
      | { status: "ADDED" }
      | { status: "INVITED"; token: string };
    if (result.status === "ADDED") {
      setMessage(`${inviteEmail} was added to the workspace.`);
      void refreshMembers();
    } else {
      setInviteLink(
        `${window.location.origin}/invitations/accept?token=${result.token}`,
      );
      setMessage(
        `${inviteEmail} has no account yet. Share the invitation link below.`,
      );
      void refreshInvitations();
    }
    setInviteEmail("");
  };

  const updateRole = async (userId: string, role: Role) => {
    const response = await fetch(`/api/workspace/members/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (response.ok) void refreshMembers();
    else setMessage("Could not update that member's role.");
  };

  const removeMember = async (userId: string) => {
    const response = await fetch(`/api/workspace/members/${userId}`, {
      method: "DELETE",
    });
    if (response.ok) void refreshMembers();
    else setMessage("Could not remove that member.");
  };

  const revokeInvitation = async (invitationId: string) => {
    const response = await fetch(
      `/api/workspace/invitations/${invitationId}`,
      { method: "DELETE" },
    );
    if (response.ok) void refreshInvitations();
  };

  const saveRetention = async () => {
    if (!retention) return;
    const response = await fetch("/api/workspace/retention-policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(retention),
    });
    setMessage(
      response.ok
        ? "Retention policy saved."
        : "Could not save the retention policy.",
    );
  };

  if (!isAdmin)
    return (
      <section className="ai-settings">
        <p>You need the admin or owner role to view workspace administration.</p>
      </section>
    );

  return (
    <div className="ai-settings">
      <section>
        <h2>Members</h2>
        {members.map((member) => (
          <div key={member.userId} className="admin-row">
            <span>
              {member.displayName} &lt;{member.email}&gt;
            </span>
            <select
              value={member.role}
              onChange={(event) =>
                void updateRole(member.userId, event.target.value as Role)
              }
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void removeMember(member.userId)}>
              Remove
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2>Invite a member</h2>
        <label>
          Email
          <input
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
          />
        </label>
        <label>
          Role
          <select
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as Role)}
          >
            {ROLES.filter((role) => role !== "OWNER").map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void inviteMember()}>
          Invite
        </button>
        {inviteLink && <p className="hint">{inviteLink}</p>}
        {message && <p className="hint">{message}</p>}
      </section>

      {invitations.length > 0 && (
        <section>
          <h2>Pending invitations</h2>
          {invitations.map((invitation) => (
            <div key={invitation.id} className="admin-row">
              <span>
                {invitation.email} — {invitation.role}
              </span>
              <button
                type="button"
                onClick={() => void revokeInvitation(invitation.id)}
              >
                Revoke
              </button>
            </div>
          ))}
        </section>
      )}

      {retention && (
        <section>
          <h2>Retention policy</h2>
          <label>
            Auto-delete recordings after (days, blank = keep forever)
            <input
              type="number"
              min={1}
              value={retention.recordingRetentionDays ?? ""}
              onChange={(event) =>
                setRetention({
                  ...retention,
                  recordingRetentionDays: event.target.value
                    ? Number(event.target.value)
                    : null,
                })
              }
            />
          </label>
          <label>
            Permanently purge deleted recordings after (days)
            <input
              type="number"
              min={1}
              value={retention.deletedRecordingPurgeDays}
              onChange={(event) =>
                setRetention({
                  ...retention,
                  deletedRecordingPurgeDays: Number(event.target.value),
                })
              }
            />
          </label>
          <button type="button" onClick={() => void saveRetention()}>
            Save retention policy
          </button>
        </section>
      )}

      <section>
        <h2>Audit log</h2>
        {auditEvents.map((event) => (
          <div key={event.id} className="admin-row">
            <span>
              {new Date(event.createdAt).toLocaleString()} —{" "}
              {event.actorEmail ?? "system"} — {event.action}
              {event.targetId ? ` (${event.targetType}:${event.targetId})` : ""}
            </span>
          </div>
        ))}
        {auditCursor && (
          <button type="button" onClick={() => void loadAuditEvents(auditCursor)}>
            Load more
          </button>
        )}
      </section>
    </div>
  );
}
