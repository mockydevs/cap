"use client";

import { useState } from "react";

type Visibility = "PRIVATE" | "LINK" | "PASSWORD" | "PUBLIC";
type ShareResult = {
  visibility: Visibility;
  shareToken?: string;
  expiresAt?: string;
};
export function ShareControls({ recordingId }: { recordingId: string }) {
  const [visibility, setVisibility] = useState<Visibility>("PRIVATE");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<ShareResult>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const response = await fetch(`/api/recordings/${recordingId}/sharing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        visibility,
        ...(visibility === "PASSWORD" ? { password } : {}),
        ...(visibility === "LINK" || visibility === "PASSWORD"
          ? { expiresInHours: 168 }
          : {}),
      }),
    });
    if (!response.ok) {
      setError(
        response.status === 403
          ? "You do not have permission to change sharing."
          : "Sharing settings could not be saved.",
      );
      setSaving(false);
      return;
    }
    setResult((await response.json()) as ShareResult);
    setSaving(false);
  }
  const shareUrl = result?.shareToken
    ? `${window.location.origin}/share/${result.shareToken}`
    : result?.visibility === "PUBLIC"
      ? `${window.location.origin}/watch/${recordingId}`
      : undefined;
  return (
    <aside className="share-panel">
      <h2>Share recording</h2>
      <p className="share-intro">
        Control who can watch, then send one secure link.
      </p>
      <form onSubmit={save} className="share-form">
        <label>
          Access
          <select
            value={visibility}
            onChange={(event) =>
              setVisibility(event.target.value as Visibility)
            }
          >
            <option value="PRIVATE">Private workspace</option>
            <option value="LINK">Anyone with the link</option>
            <option value="PASSWORD">Password protected</option>
            <option value="PUBLIC">Public</option>
          </select>
        </label>
        {visibility === "PASSWORD" && (
          <label>
            Password
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save access"}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      {shareUrl && (
        <div className="share-result">
          <input readOnly value={shareUrl} aria-label="Share link" />
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(shareUrl);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1800);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          {result?.expiresAt && (
            <small>Expires {new Date(result.expiresAt).toLocaleString()}</small>
          )}
        </div>
      )}
    </aside>
  );
}
