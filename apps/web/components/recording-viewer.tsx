"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ShareControls } from "./share-controls";
import { CommentThread } from "./comment-thread";
import { TranscriptPanel } from "./transcript-panel";
import { AiPanel } from "./ai-panel";

type Recording = {
  id: string;
  title: string;
  status: "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
  sizeBytes: number | null;
  createdAt: string;
  canManageSharing: boolean;
};
type Playback = {
  url: string;
  expiresAt: string;
};
export function RecordingViewer({
  recordingId,
  initialTimestampMs,
}: {
  recordingId: string;
  initialTimestampMs?: number;
}) {
  const [recording, setRecording] = useState<Recording>();
  const [playback, setPlayback] = useState<Playback>();
  const [error, setError] = useState<string>();
  const [timestampMs, setTimestampMs] = useState(0);
  const playerRef = useRef<HTMLVideoElement>(null);
  const load = useCallback(async () => {
    const response = await fetch(`/api/recordings/${recordingId}`, {
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
    if (response.status === 404) {
      setError("Recording not found in this workspace.");
      return;
    }
    if (!response.ok) {
      setError("Could not load this recording.");
      return;
    }
    const next = (await response.json()) as Recording;
    setRecording(next);
    if (next.status === "READY") {
      const media = await fetch(`/api/recordings/${recordingId}/playback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      if (media.ok) setPlayback((await media.json()) as Playback);
      else setError("Playback is temporarily unavailable.");
    }
  }, [recordingId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      !recording ||
      (recording.status !== "UPLOADING" && recording.status !== "PROCESSING")
    )
      return;
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [recording, load]);
  useEffect(() => {
    if (!playback || !playerRef.current || initialTimestampMs === undefined)
      return;
    playerRef.current.currentTime = initialTimestampMs / 1_000;
  }, [playback, initialTimestampMs]);
  if (error)
    return (
      <section className="viewer-shell">
        <Link href="/library">← Library</Link>
        <p className="form-error">{error}</p>
      </section>
    );
  if (!recording)
    return (
      <section className="viewer-shell">
        <p>Loading recording…</p>
      </section>
    );
  return (
    <section className="viewer-shell">
      <header className="viewer-topbar">
        <Link className="sidebar-brand" href="/library"><span className="brand-mark" aria-hidden="true" />Cap</Link>
        <Link href="/library">← Library</Link>
        <div className="viewer-actions">
          {recording.status === "READY" && (
            <Link className="editor-launch" href={`/library/${recording.id}/edit`}>
              Edit recording
            </Link>
          )}
        </div>
      </header>
      <div className="viewer-layout">
        <div className="viewer-main">
          <div className="viewer-heading">
            <div>
              <p className="eyebrow">{recording.status}</p>
              <h1>{recording.title}</h1>
            </div>
            <span>
              {new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(
                new Date(recording.createdAt),
              )}
            </span>
          </div>
          {playback ? (
            <video
              ref={playerRef}
              className="playback-player"
              controls
              preload="metadata"
              src={playback.url}
              onTimeUpdate={(event) =>
                setTimestampMs(event.currentTarget.currentTime * 1000)
              }
              onError={() => void load()}
            >
              <track
                default
                kind="subtitles"
                label="Transcript"
                src={`/api/recordings/${recordingId}/captions?format=vtt`}
                srcLang="en"
              />
            </video>
          ) : (
            <div className="processing-state">
              <span className="processing-pulse" />
              <h2>
                {recording.status === "FAILED"
                  ? "Processing failed"
                  : "Preparing playback…"}
              </h2>
              <p>
                {recording.status === "FAILED"
                  ? "The source is safe. Contact a workspace administrator to retry processing."
                  : "This page updates automatically when your video is ready."}
              </p>
            </div>
          )}
          {recording.canManageSharing && (
            <ShareControls recordingId={recording.id} />
          )}
        </div>
        <aside className="viewer-inspector">
          <div className="viewer-tabs" aria-label="Recording details">
            <span className="active">Transcript</span><span>Comments</span><span>AI</span>
          </div>
          <TranscriptPanel
            recordingId={recording.id}
            onSeek={(positionMs) => {
              if (!playerRef.current) return;
              playerRef.current.currentTime = positionMs / 1_000;
              void playerRef.current.play().catch(() => undefined);
            }}
          />
          <CommentThread recordingId={recording.id} timestampMs={timestampMs} />
          <AiPanel
            recordingId={recording.id}
            onSeek={(positionMs) => {
              if (!playerRef.current) return;
              playerRef.current.currentTime = positionMs / 1000;
              void playerRef.current.play().catch(() => undefined);
            }}
          />
        </aside>
      </div>
    </section>
  );
}
