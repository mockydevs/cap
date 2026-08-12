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
    <section className="library-shell">
      <aside className="library-sidebar">
        <Link className="sidebar-brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          <span>Cap</span>
        </Link>
        <Link className="sidebar-record" href="/">
          <span className="record-dot" aria-hidden="true" />
          New recording
        </Link>
        <nav className="sidebar-nav" aria-label="Library navigation">
          <Link className="active" href="/library">
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" /><path d="m10 9 5 3-5 3Z" /></svg>
            Library
          </Link>
          <span aria-disabled="true"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 12v8h16v-8M12 3v13m-5-5 5 5 5-5" /></svg>Shared with me</span>
          <span aria-disabled="true"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 3 2.5 5.5 6 .5-4.5 4 1.4 6L12 16l-5.4 3L8 13 3.5 9l6-.5Z" /></svg>Starred</span>
          <span aria-disabled="true"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" /></svg>Trash</span>
        </nav>
        <div className="sidebar-footer">
          <Link href="/admin">Settings</Link>
          <div className="workspace-chip">
            <span className="avatar">W</span>
            <span><strong>Your workspace</strong><small>Private recordings</small></span>
          </div>
        </div>
      </aside>
      <div className="library-panel">
        <div className="library-heading">
          <div>
            <p className="eyebrow">Browser-first screen recording</p>
            <h1>Recordings</h1>
          </div>
          <span className="recording-count">{items.length} shown</span>
        </div>
        <div className="library-tools">
          <TranscriptSearch />
        </div>
        <nav className="library-filters" aria-label="Recording filters">
          <span className="active">All · {items.length}</span>
          <span>
            Ready · {items.filter((item) => item.status === "READY").length}
          </span>
          <span>
            Processing · {items.filter((item) => item.status === "PROCESSING" || item.status === "UPLOADING").length}
          </span>
          <span>
            Failed · {items.filter((item) => item.status === "FAILED").length}
          </span>
        </nav>
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
              <span className="recording-play" aria-hidden="true">▶</span>
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
      </div>
    </section>
  );
}
