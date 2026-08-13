"use client";

import Link from "next/link";
import { WorkspaceMark } from "./workspace-mark";
import { useEffect, useState } from "react";
import { sendJson } from "../lib/http/json";
import { CommentThread } from "./comment-thread";

type Playback = {
  recordingId: string;
  title: string;
  url: string;
  expiresAt: string;
};

const unavailable = (code: string | undefined) =>
  code === "RECORDING_NOT_READY"
    ? "This recording is still being processed. Try again in a few minutes."
    : "This recording is unavailable or the link has expired.";

export function SharedRecording({
  token,
  recordingId,
}: {
  token?: string;
  recordingId?: string;
}) {
  const [playback, setPlayback] = useState<Playback>();
  const [error, setError] = useState<string>();
  const [opening, setOpening] = useState(true);
  const [timestampMs, setTimestampMs] = useState(0);
  const endpoint = token
    ? `/api/shares/${token}/playback`
    : `/api/recordings/${recordingId}/playback`;

  // The link is the credential, so arriving with it is the whole request:
  // open the recording rather than asking the recipient to ask for it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await sendJson(endpoint, "POST", {});
      if (cancelled) return;
      setOpening(false);
      if (response.ok) {
        setPlayback((await response.json()) as Playback);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      setError(unavailable(body.error?.code));
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);
  return (
    <main className="shared-shell">
      <header className="shared-header">
        <WorkspaceMark href="/" />
        <div className="shared-header-actions">
          <span>Shared with Cap</span>
          <Link className="nav-cta" href="/signup">
            Create your workspace
          </Link>
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
              <span className="shared-ready">
                <i /> Ready to watch
              </span>
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
                // A signed URL that the browser cannot load would otherwise
                // leave a black rectangle and no explanation.
                onError={() =>
                  setError(
                    "The video could not be loaded. The link may have expired — reload the page to try again.",
                  )
                }
              />
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
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
                share={{ token }}
              />
            </aside>
          )}
        </div>
      ) : (
        <div className="share-gate-layout">
          <section className="share-gate">
            <span className="share-gate-index">01 / Playback</span>
            <p className="eyebrow">Shared recording</p>
            {opening ? (
              <>
                <h1>Opening the recording.</h1>
                <p>One moment while playback is prepared.</p>
                <span className="state-loader" aria-hidden="true" />
              </>
            ) : (
              <>
                <h1>This link is not available.</h1>
                <p>
                  Ask the sender for a new link — shared links expire, and can
                  be turned off at any time.
                </p>
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </section>
          <aside className="share-assurance" aria-label="About secure sharing">
            <div className="share-assurance-graphic" aria-hidden="true">
              <span />
              <span />
              <span />
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
