"use client";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@cap/domain";
import { useCallback, useEffect, useState } from "react";
import { fetchFresh, sendJson } from "../lib/http/json";
import { AiSettings } from "./ai-settings";

type Member = {
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  joinedAt: string;
};
type Invitation = {
  id: string;
  email: string;
  role: WorkspaceRole;
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
type WebhookEndpoint = {
  id: string;
  url: string;
  description: string | null;
  secretFingerprint: string;
  enabledEvents: string[];
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
};

type ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const ROLES = WORKSPACE_ROLES;
const WEBHOOK_EVENTS = [
  "recording.ready",
  "recording.deleted",
  "transcript.ready",
  "ai_artifact.created",
  "comment.created",
] as const;

export function AdminPanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [retention, setRetention] = useState<RetentionPolicy>();
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("MEMBER");
  const [inviteLink, setInviteLink] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [isAdmin, setIsAdmin] = useState(true);
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>([
    "recording.ready",
  ]);
  const [newWebhookSecret, setNewWebhookSecret] = useState<string>();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeyName, setApiKeyName] = useState("");
  const [newApiKey, setNewApiKey] = useState<string>();

  const refreshMembers = useCallback(async () => {
    const response = await fetchFresh("/api/workspace/members");
    if (response.ok)
      setMembers(((await response.json()) as { items: Member[] }).items);
  }, []);

  const refreshInvitations = useCallback(async () => {
    const response = await fetchFresh("/api/workspace/invitations");
    if (response.status === 403) {
      setIsAdmin(false);
      return;
    }
    if (response.ok)
      setInvitations(
        ((await response.json()) as { items: Invitation[] }).items,
      );
  }, []);

  const refreshRetention = useCallback(async () => {
    const response = await fetchFresh("/api/workspace/retention-policy");
    if (response.ok) setRetention(await response.json());
  }, []);

  const loadAuditEvents = useCallback(async (cursor?: string) => {
    const response = await fetchFresh(
      `/api/workspace/audit-events?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
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

  const refreshWebhooks = useCallback(async () => {
    const response = await fetchFresh("/api/workspace/webhooks");
    if (response.ok)
      setWebhooks(
        ((await response.json()) as { items: WebhookEndpoint[] }).items,
      );
  }, []);

  const refreshApiKeys = useCallback(async () => {
    const response = await fetchFresh("/api/workspace/api-keys");
    if (response.ok)
      setApiKeys(((await response.json()) as { items: ApiKey[] }).items);
  }, []);

  useEffect(() => {
    void refreshMembers();
    void refreshInvitations();
    void refreshRetention();
    void loadAuditEvents();
    void refreshWebhooks();
    void refreshApiKeys();
  }, [
    refreshMembers,
    refreshInvitations,
    refreshRetention,
    loadAuditEvents,
    refreshWebhooks,
    refreshApiKeys,
  ]);

  const createWebhook = async () => {
    setNewWebhookSecret(undefined);
    const response = await sendJson("/api/workspace/webhooks", "POST", {
      url: webhookUrl,
      enabledEvents: webhookEvents,
    });
    if (!response.ok) {
      setMessage("Could not create that webhook. The URL must be HTTPS.");
      return;
    }
    const created = (await response.json()) as { secret: string };
    setNewWebhookSecret(created.secret);
    setWebhookUrl("");
    void refreshWebhooks();
  };

  const deleteWebhook = async (id: string) => {
    const response = await sendJson(`/api/workspace/webhooks/${id}`, "DELETE");
    if (response.ok) void refreshWebhooks();
  };

  const createApiKey = async () => {
    setNewApiKey(undefined);
    const response = await sendJson("/api/workspace/api-keys", "POST", {
      name: apiKeyName,
    });
    if (!response.ok) {
      setMessage("Could not create that API key.");
      return;
    }
    const created = (await response.json()) as { key: string };
    setNewApiKey(created.key);
    setApiKeyName("");
    void refreshApiKeys();
  };

  const revokeApiKey = async (id: string) => {
    const response = await sendJson(`/api/workspace/api-keys/${id}`, "DELETE");
    if (response.ok) void refreshApiKeys();
  };

  const inviteMember = async () => {
    setMessage(undefined);
    setInviteLink(undefined);
    const response = await sendJson("/api/workspace/members", "POST", {
      email: inviteEmail,
      role: inviteRole,
    });
    if (!response.ok) {
      setMessage("Could not invite that member.");
      return;
    }
    const result = (await response.json()) as
      { status: "ADDED" } | { status: "INVITED"; token: string };
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

  const updateRole = async (userId: string, role: WorkspaceRole) => {
    const response = await sendJson(
      `/api/workspace/members/${userId}`,
      "PATCH",
      { role },
    );
    if (response.ok) void refreshMembers();
    else setMessage("Could not update that member's role.");
  };

  const removeMember = async (userId: string) => {
    const response = await sendJson(
      `/api/workspace/members/${userId}`,
      "DELETE",
    );
    if (response.ok) void refreshMembers();
    else setMessage("Could not remove that member.");
  };

  const revokeInvitation = async (invitationId: string) => {
    const response = await sendJson(
      `/api/workspace/invitations/${invitationId}`,
      "DELETE",
    );
    if (response.ok) void refreshInvitations();
  };

  const saveRetention = async () => {
    if (!retention) return;
    const response = await sendJson(
      "/api/workspace/retention-policy",
      "PUT",
      retention,
    );
    setMessage(
      response.ok
        ? "Retention policy saved."
        : "Could not save the retention policy.",
    );
  };

  if (!isAdmin)
    return (
      <section className="ai-settings">
        <p>
          You need the admin or owner role to view workspace administration.
        </p>
      </section>
    );

  return (
    <div className="ai-settings">
      <section className="admin-section admin-section-members" id="members">
        <header className="admin-section-heading">
          <div>
            <span>01</span>
            <h2>Members</h2>
          </div>
          <p>Control who can access this workspace and what they can do.</p>
        </header>
        {members.map((member) => (
          <div key={member.userId} className="admin-row">
            <span>
              {member.displayName} &lt;{member.email}&gt;
            </span>
            <select
              value={member.role}
              onChange={(event) =>
                void updateRole(
                  member.userId,
                  event.target.value as WorkspaceRole,
                )
              }
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void removeMember(member.userId)}
            >
              Remove
            </button>
          </div>
        ))}
      </section>

      <section className="admin-section admin-section-invite">
        <header className="admin-section-heading compact">
          <div>
            <span>+</span>
            <h2>Invite a member</h2>
          </div>
          <p>Add a teammate using their email address.</p>
        </header>
        <div className="admin-form-row">
          <label className="admin-field admin-field-grow">
            Email
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
            />
          </label>
          <label className="admin-field">
            Role
            <select
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(event.target.value as WorkspaceRole)
              }
            >
              {ROLES.filter((role) => role !== "OWNER").map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <button
            className="admin-form-action"
            type="button"
            onClick={() => void inviteMember()}
          >
            Invite
          </button>
        </div>
        {inviteLink && <p className="hint">{inviteLink}</p>}
        {message && <p className="hint">{message}</p>}
      </section>

      {invitations.length > 0 && (
        <section className="admin-section admin-section-invitations">
          <header className="admin-section-heading compact">
            <div>
              <span>↗</span>
              <h2>Pending invitations</h2>
            </div>
          </header>
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
        <section className="admin-section admin-section-retention">
          <header className="admin-section-heading">
            <div>
              <span>02</span>
              <h2>Retention policy</h2>
            </div>
            <p>
              Choose how long recordings and deleted items remain available.
            </p>
          </header>
          <div className="admin-field-stack">
            <label className="admin-field admin-field-inline">
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
            <label className="admin-field admin-field-inline">
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
          </div>
          <button
            className="admin-secondary-action"
            type="button"
            onClick={() => void saveRetention()}
          >
            Save retention policy
          </button>
        </section>
      )}

      <section
        className="admin-section admin-section-webhooks"
        id="integrations"
      >
        <header className="admin-section-heading">
          <div>
            <span>03</span>
            <h2>Webhooks</h2>
          </div>
          <p>Send recording events to your own HTTPS endpoint.</p>
        </header>
        {webhooks.map((webhook) => (
          <div key={webhook.id} className="admin-row">
            <span>
              {webhook.url} — {webhook.enabledEvents.join(", ")} — secret …
              {webhook.secretFingerprint}
              {webhook.lastDeliveryStatus
                ? ` — last delivery ${webhook.lastDeliveryStatus.toLowerCase()}`
                : ""}
            </span>
            <button
              type="button"
              onClick={() => void deleteWebhook(webhook.id)}
            >
              Delete
            </button>
          </div>
        ))}
        <label className="admin-field">
          Endpoint URL (HTTPS)
          <input
            type="url"
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
            placeholder="https://example.com/webhooks/cap"
          />
        </label>
        <fieldset className="webhook-event-grid">
          {WEBHOOK_EVENTS.map((event) => (
            <label key={event}>
              <input
                type="checkbox"
                checked={webhookEvents.includes(event)}
                onChange={(changeEvent) =>
                  setWebhookEvents((current) =>
                    changeEvent.target.checked
                      ? [...current, event]
                      : current.filter((value) => value !== event),
                  )
                }
              />
              {event}
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          disabled={!webhookUrl || webhookEvents.length === 0}
          onClick={() => void createWebhook()}
        >
          Add webhook
        </button>
        {newWebhookSecret && (
          <p className="hint">
            Signing secret (shown once, store it now): {newWebhookSecret}
          </p>
        )}
      </section>

      <section className="admin-section admin-section-ai" id="ai">
        <header className="admin-section-heading">
          <div>
            <span>04</span>
            <h2>AI providers</h2>
          </div>
          <p>
            Connect providers, route each capability, and cap monthly AI spend.
          </p>
        </header>
        <AiSettings />
      </section>

      <section className="admin-section admin-section-api" id="security">
        <header className="admin-section-heading">
          <div>
            <span>05</span>
            <h2>API keys</h2>
          </div>
          <p>Create scoped credentials for trusted tools and integrations.</p>
        </header>
        {apiKeys.map((apiKey) => (
          <div key={apiKey.id} className="admin-row">
            <span>
              {apiKey.name} — {apiKey.keyPrefix}…
              {apiKey.revokedAt
                ? " — revoked"
                : apiKey.lastUsedAt
                  ? ` — last used ${new Date(apiKey.lastUsedAt).toLocaleString()}`
                  : " — never used"}
            </span>
            {!apiKey.revokedAt && (
              <button
                type="button"
                onClick={() => void revokeApiKey(apiKey.id)}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
        <label className="admin-field">
          Key name
          <input
            value={apiKeyName}
            onChange={(event) => setApiKeyName(event.target.value)}
            placeholder="e.g. Zapier integration"
          />
        </label>
        <button
          type="button"
          disabled={apiKeyName.trim().length < 2}
          onClick={() => void createApiKey()}
        >
          Create API key
        </button>
        {newApiKey && (
          <p className="hint">Key (shown once, store it now): {newApiKey}</p>
        )}
      </section>

      <section className="admin-section admin-section-audit">
        <header className="admin-section-heading">
          <div>
            <span>06</span>
            <h2>Audit log</h2>
          </div>
          <p>A chronological record of important workspace activity.</p>
        </header>
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
          <button
            type="button"
            onClick={() => void loadAuditEvents(auditCursor)}
          >
            Load more
          </button>
        )}
      </section>
    </div>
  );
}
