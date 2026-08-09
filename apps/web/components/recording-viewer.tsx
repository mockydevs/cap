"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ShareControls } from "./share-controls";

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
export function RecordingViewer({ recordingId }: { recordingId: string }) {
  const [recording, setRecording] = useState<Recording>();
  const [playback, setPlayback] = useState<Playback>();
  const [error, setError] = useState<string>();
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
      <Link href="/library">← Library</Link>
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
          className="playback-player"
          controls
          preload="metadata"
          src={playback.url}
          onError={() => void load()}
        />
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
    </section>
  );
}
