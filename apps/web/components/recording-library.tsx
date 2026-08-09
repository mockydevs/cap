"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { TranscriptSearch } from "./transcript-search";

type RecordingSummary = {
  id: string;
  title: string;
  status: "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
};
type Page = { items: RecordingSummary[]; nextCursor: string | null };

export function RecordingLibrary() {
  const [items, setItems] = useState<RecordingSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(undefined);
    const response = await fetch(
      `/api/recordings?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      { cache: "no-store" },
    );
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
    if (!response.ok) {
      setError("Could not load your recording library.");
      setLoading(false);
      return;
    }
    const page = (await response.json()) as Page;
    setItems((current) => (cursor ? [...current, ...page.items] : page.items));
    setNextCursor(page.nextCursor);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      !items.some(
        (item) => item.status === "UPLOADING" || item.status === "PROCESSING",
      )
    )
      return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [items, load]);
  return (
    <section className="library-panel">
      <div className="library-heading">
        <div>
          <p className="eyebrow">Your workspace</p>
          <h1>Recordings</h1>
        </div>
        <Link className="nav-cta" href="/">
          New recording
        </Link>
      </div>
      <TranscriptSearch />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!loading && items.length === 0 && (
        <div className="empty-state">
          <h2>No recordings yet.</h2>
          <p>
            Capture your first walkthrough and upload it to your private
            workspace.
          </p>
          <Link className="nav-cta" href="/">
            Start recording
          </Link>
        </div>
      )}
      <div className="recording-grid">
        {items.map((recording) => (
          <Link
            href={`/library/${recording.id}`}
            className="recording-card"
            key={recording.id}
          >
            <div className="recording-art">
              <span
                className={`recording-status status-${recording.status.toLowerCase()}`}
              >
                {recording.status}
              </span>
              <span aria-hidden="true">▶</span>
            </div>
            <h2>{recording.title}</h2>
            <p>
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(recording.createdAt))}
            </p>
          </Link>
        ))}
      </div>
      {nextCursor && (
        <button
          className="load-more"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
