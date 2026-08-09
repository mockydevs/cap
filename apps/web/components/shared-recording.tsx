"use client";

import Link from "next/link";
import { useState } from "react";

type Playback = { title: string; url: string; expiresAt: string };
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
      <Link className="brand" href="/">
        cap
      </Link>
      {playback ? (
        <>
          <h1>{playback.title}</h1>
          <video
            className="playback-player"
            controls
            autoPlay
            src={playback.url}
          />
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
