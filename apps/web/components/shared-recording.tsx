"use client";

import Link from "next/link";
import { useState } from "react";
import { CommentThread } from "./comment-thread";

type Playback = {
  recordingId: string;
  title: string;
  url: string;
  expiresAt: string;
};
export function SharedRecording({
  token,
  recordingId,
}: {
  token?: string;
  recordingId?: string;
}) {
  const [password, setPassword] = useState("");
  const [playback, setPlayback] = useState<Playback>();
  const [error, setError] = useState<string>();
  const [timestampMs, setTimestampMs] = useState(0);
  const endpoint = token
    ? `/api/shares/${token}/playback`
    : `/api/recordings/${recordingId}/playback`;
  async function open(event?: React.FormEvent) {
    event?.preventDefault();
    setError(undefined);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(password ? { password } : {}),
    });
    if (!response.ok) {
      setError(
        response.status === 401
          ? "A valid password is required."
          : "This recording is unavailable or the link has expired.",
      );
      return;
    }
    setPlayback((await response.json()) as Playback);
  }
  return (
    <main className="shared-shell">
      <header className="shared-header">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />cap
        </Link>
        <div className="shared-header-actions">
          <span>Shared with Cap</span>
          <Link className="nav-cta" href="/signup">Create your workspace</Link>
        </div>
      </header>
      {playback ? (
        <div className={`shared-view ${token ? "shared-view-comments" : ""}`}>
          <section className="shared-stage">
            <div className="shared-title">
              <div>
                <p className="eyebrow">Shared recording</p>
                <h1>{playback.title}</h1>
              </div>
              <span className="shared-ready"><i /> Ready to watch</span>
            </div>
            <div className="shared-video-frame">
              <video
                className="playback-player"
                controls
                autoPlay
                playsInline
                src={playback.url}
                onTimeUpdate={(event) =>
                  setTimestampMs(event.currentTarget.currentTime * 1000)
                }
              />
            </div>
            <div className="shared-context">
              <span>Private playback link</span>
              <span>Comments stay attached to the timeline</span>
            </div>
          </section>
          {token && (
            <aside className="shared-comments">
              <CommentThread
                recordingId={playback.recordingId}
                timestampMs={timestampMs}
                share={{ token, password }}
              />
            </aside>
          )}
        </div>
      ) : (
        <div className="share-gate-layout">
          <section className="share-gate">
            <span className="share-gate-index">01 / Playback</span>
            <p className="eyebrow">Shared recording</p>
            <h1>Ready when you are.</h1>
            <p>
              This recording was shared securely through Cap. Open it directly,
              or enter the password supplied by the sender.
            </p>
            <form onSubmit={open} className="share-form">
              <label>
                Password <small>Only if the sender provided one</small>
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Enter recording password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button type="submit">Open recording <span aria-hidden="true">→</span></button>
            </form>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="share-skip" type="button" onClick={() => void open()}>
              Continue without a password
            </button>
          </section>
          <aside className="share-assurance" aria-label="About secure sharing">
            <div className="share-assurance-graphic" aria-hidden="true">
              <span /><span /><span />
            </div>
            <div>
              <p className="eyebrow">Context, not another meeting</p>
              <h2>Watch. Comment. Keep moving.</h2>
              <ul>
                <li>Timestamped feedback</li>
                <li>Secure, expiring access</li>
                <li>No download required</li>
              </ul>
            </div>
          </aside>
        </div>
      )}
      <footer className="shared-footer">
        <span>Powered by Cap</span>
        <Link href="/">Learn about Cap</Link>
      </footer>
    </main>
  );
}
