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
        <Link className="brand" href="/"><span className="brand-mark" aria-hidden="true" />cap</Link>
        <Link className="nav-cta" href="/signup">Sign up free</Link>
      </header>
      {playback ? (
        <>
          <p className="eyebrow">Shared recording</p>
          <h1>{playback.title}</h1>
          <video
            className="playback-player"
            controls
            autoPlay
            src={playback.url}
            onTimeUpdate={(event) =>
              setTimestampMs(event.currentTarget.currentTime * 1000)
            }
          />
          {token && (
            <CommentThread
              recordingId={playback.recordingId}
              timestampMs={timestampMs}
              share={{ token, password }}
            />
          )}
        </>
      ) : (
        <section className="share-gate">
          <p className="eyebrow">Shared recording</p>
          <h1>Ready when you are.</h1>
          <p>
            Open this recording. If it is password protected, enter the password
            below.
          </p>
          <form onSubmit={open} className="share-form">
            <label>
              Password (if required)
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button type="submit">Open recording</button>
          </form>
          {error && <p className="form-error">{error}</p>}
          <button className="nav-link" onClick={() => void open()}>
            Open without password
          </button>
        </section>
      )}
    </main>
  );
}
