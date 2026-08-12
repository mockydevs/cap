"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchFresh } from "../lib/http/json";
import { TranscriptSearch } from "./transcript-search";

type LibraryView = "library" | "shared" | "starred" | "trash";
type RecordingStatus =
  | "UPLOADING"
  | "PROCESSING"
  | "READY"
  | "FAILED"
  | "DELETED";
type StatusFilter = "ALL" | "READY" | "PROCESSING" | "FAILED";
type RecordingSummary = {
  id: string;
  ownerId: string;
  ownerName: string;
  title: string;
  status: RecordingStatus;
  previousStatus: RecordingStatus | null;
  visibility: "PRIVATE" | "LINK" | "PASSWORD" | "PUBLIC";
  sizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  isStarred: boolean;
  canDelete: boolean;
};
type Page = { items: RecordingSummary[]; nextCursor: string | null };

const viewContent: Record<
  LibraryView,
  { eyebrow: string; title: string; description: string; emptyTitle: string; emptyBody: string }
> = {
  library: {
    eyebrow: "Browser-first screen recording",
    title: "Recordings",
    description: "Capture, organize, and share everything your team needs to see.",
    emptyTitle: "Make your first recording.",
    emptyBody: "Record a product walkthrough, a quick update, or anything that is easier to show than explain.",
  },
  shared: {
    eyebrow: "Workspace collaboration",
    title: "Shared with me",
    description: "Recordings created by other people in your active workspace.",
    emptyTitle: "Nothing shared yet.",
    emptyBody: "When a teammate creates a recording in this workspace, it will appear here automatically.",
  },
  starred: {
    eyebrow: "Quick access",
    title: "Starred",
    description: "Keep important recordings close without moving or duplicating them.",
    emptyTitle: "No starred recordings.",
    emptyBody: "Use the star on any recording to add it to this focused view.",
  },
  trash: {
    eyebrow: "Recoverable deletion",
    title: "Trash",
    description: "Restore deleted recordings or permanently remove them from storage.",
    emptyTitle: "Trash is empty.",
    emptyBody: "Deleted recordings remain recoverable here until your workspace retention policy removes them.",
  },
};

export function RecordingLibrary({ initialView }: { initialView: LibraryView }) {
  const router = useRouter();
  const [items, setItems] = useState<RecordingSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [activeAction, setActiveAction] = useState<string>();
  const content = viewContent[initialView];

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams({ limit: "20", view: initialView });
      if (cursor) params.set("cursor", cursor);
      const response = await fetchFresh(`/api/recordings?${params}`);
      if (response.status === 401) {
        router.replace("/login");
        return;
      }
      if (!response.ok) {
        setError("Could not load this recording view.");
        setLoading(false);
        return;
      }
      const page = (await response.json()) as Page;
      setItems((current) => (cursor ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setLoading(false);
    },
    [initialView, router],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (
      initialView === "trash" ||
      !items.some(
        (item) => item.status === "UPLOADING" || item.status === "PROCESSING",
      )
    )
      return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [initialView, items, load]);

  const effectiveStatus = (item: RecordingSummary) =>
    item.status === "DELETED" ? (item.previousStatus ?? "FAILED") : item.status;
  const filteredItems = useMemo(
    () =>
      items.filter((item) => {
        if (statusFilter === "ALL") return true;
        const status = effectiveStatus(item);
        if (statusFilter === "PROCESSING")
          return status === "PROCESSING" || status === "UPLOADING";
        return status === statusFilter;
      }),
    [items, statusFilter],
  );

  async function performAction(
    recording: RecordingSummary,
    action: "star" | "unstar" | "trash" | "restore" | "purge",
  ) {
    if (
      action === "purge" &&
      !window.confirm(
        `Permanently delete “${recording.title}”? This cannot be undone.`,
      )
    )
      return;
    const endpoint =
      action === "star" || action === "unstar"
        ? `/api/recordings/${recording.id}/star`
        : action === "restore" || action === "purge"
          ? `/api/recordings/${recording.id}/${action}`
          : `/api/recordings/${recording.id}`;
    const method =
      action === "star" ? "PUT" : action === "restore" ? "POST" : "DELETE";
    setActiveAction(`${recording.id}:${action}`);
    setError(undefined);
    const response = await fetch(endpoint, { method });
    setActiveAction(undefined);
    if (!response.ok) {
      setError(
        response.status === 403
          ? "You do not have permission to change that recording."
          : "That recording could not be updated. Please try again.",
      );
      return;
    }
    await load();
  }

  const processingCount = items.filter((item) => {
    const status = effectiveStatus(item);
    return status === "PROCESSING" || status === "UPLOADING";
  }).length;

  return (
    <section className="library-shell">
      <aside className="library-sidebar">
        <Link className="sidebar-brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          <span>Cap</span>
        </Link>
        <Link className="sidebar-record" href="/record">
          <span className="record-dot" aria-hidden="true" />
          New recording
        </Link>
        <nav className="sidebar-nav" aria-label="Library navigation">
          <LibraryNavLink view="library" activeView={initialView} label="Library">
            <rect x="3" y="5" width="18" height="14" />
            <path d="m10 9 5 3-5 3Z" />
          </LibraryNavLink>
          <LibraryNavLink view="shared" activeView={initialView} label="Shared with me">
            <path d="M4 12v8h16v-8M12 3v13m-5-5 5 5 5-5" />
          </LibraryNavLink>
          <LibraryNavLink view="starred" activeView={initialView} label="Starred">
            <path d="m12 3 2.5 5.5 6 .5-4.5 4 1.4 6L12 16l-5.4 3L8 13 3.5 9l6-.5Z" />
          </LibraryNavLink>
          <LibraryNavLink view="trash" activeView={initialView} label="Trash">
            <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
          </LibraryNavLink>
        </nav>
        <div className="sidebar-footer">
          <Link href="/admin">Settings</Link>
          <div className="workspace-chip">
            <span className="avatar">W</span>
            <span>
              <strong>Your workspace</strong>
              <small>Private recordings</small>
            </span>
          </div>
        </div>
      </aside>
      <div className="library-panel">
        <div className="library-heading">
          <div className="library-title">
            <p className="eyebrow">{content.eyebrow}</p>
            <h1>{content.title}</h1>
            <p>{content.description}</p>
          </div>
          <div className="library-heading-actions">
            <span className="recording-count">{items.length} shown</span>
            {initialView !== "trash" && (
              <Link className="library-new-recording" href="/record">
                <span className="record-dot" aria-hidden="true" />
                New recording
              </Link>
            )}
          </div>
        </div>
        <div className="library-command-bar">
          <div className="library-tools">
            <TranscriptSearch />
          </div>
          <span className="library-privacy">
            <span aria-hidden="true" />
            {initialView === "trash" ? "Retention protected" : "Private workspace"}
          </span>
        </div>
        {initialView !== "trash" && (
          <nav className="library-filters" aria-label="Recording filters">
            {([
              ["ALL", `All · ${items.length}`],
              ["READY", `Ready · ${items.filter((item) => effectiveStatus(item) === "READY").length}`],
              ["PROCESSING", `Processing · ${processingCount}`],
              ["FAILED", `Failed · ${items.filter((item) => effectiveStatus(item) === "FAILED").length}`],
            ] as const).map(([filter, label]) => (
              <button
                key={filter}
                type="button"
                className={statusFilter === filter ? "active" : ""}
                onClick={() => setStatusFilter(filter)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!loading && items.length === 0 && (
          <div className={`empty-state empty-state-${initialView}`}>
            <div className="empty-state-visual" aria-hidden="true">
              <div className="empty-window-bar"><span /><span /><span /></div>
              <div className="empty-window-play"><span /></div>
              <div className="empty-window-track"><span /></div>
            </div>
            <div className="empty-state-copy">
              <p className="eyebrow">{content.eyebrow}</p>
              <h2>{content.emptyTitle}</h2>
              <p>{content.emptyBody}</p>
              {initialView === "library" && (
                <Link className="nav-cta" href="/record">
                  <span className="record-dot" aria-hidden="true" /> Start recording
                </Link>
              )}
              {initialView !== "library" && (
                <Link className="nav-cta empty-library-link" href="/library">
                  Return to library
                </Link>
              )}
            </div>
          </div>
        )}
        {!loading && items.length > 0 && filteredItems.length === 0 && (
          <div className="library-filter-empty">
            <strong>No recordings match this filter.</strong>
            <button type="button" onClick={() => setStatusFilter("ALL")}>Show all</button>
          </div>
        )}
        <div className="recording-grid">
          {filteredItems.map((recording) => {
            const status = effectiveStatus(recording);
            const cardContent = (
              <>
                <div className="recording-art">
                  <span className={`recording-status status-${status.toLowerCase()}`}>
                    {recording.status === "DELETED" ? "TRASHED" : status}
                  </span>
                  <span className="recording-play" aria-hidden="true">▶</span>
                </div>
                <div className="recording-card-copy">
                  <h2>{recording.title}</h2>
                  <p>
                    {initialView === "shared" && `Shared by ${recording.ownerName} · `}
                    {recording.status === "DELETED" && recording.deletedAt
                      ? `Deleted ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(recording.deletedAt))}`
                      : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(recording.createdAt))}
                  </p>
                </div>
              </>
            );
            return (
              <article className="recording-card" key={recording.id}>
                {initialView === "trash" ? (
                  <div className="recording-card-content">{cardContent}</div>
                ) : (
                  <Link className="recording-card-content" href={`/library/${recording.id}`}>
                    {cardContent}
                  </Link>
                )}
                <div className={`recording-card-actions recording-card-actions-${initialView}`}>
                  {initialView !== "trash" && (
                    <button
                      type="button"
                      className={recording.isStarred ? "is-starred" : ""}
                      disabled={Boolean(activeAction)}
                      aria-label={recording.isStarred ? `Remove star from ${recording.title}` : `Star ${recording.title}`}
                      title={recording.isStarred ? "Remove from starred" : "Add to starred"}
                      onClick={() => void performAction(recording, recording.isStarred ? "unstar" : "star")}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 3 2.5 5.5 6 .5-4.5 4 1.4 6L12 16l-5.4 3L8 13 3.5 9l6-.5Z" /></svg>
                    </button>
                  )}
                  {initialView !== "trash" && recording.canDelete && (
                    <button
                      type="button"
                      disabled={Boolean(activeAction)}
                      aria-label={`Move ${recording.title} to trash`}
                      title="Move to trash"
                      onClick={() => void performAction(recording, "trash")}
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" /></svg>
                    </button>
                  )}
                  {initialView === "trash" && recording.canDelete && (
                    <>
                      <button
                        type="button"
                        disabled={Boolean(activeAction)}
                        onClick={() => void performAction(recording, "restore")}
                      >Restore</button>
                      <button
                        className="recording-purge"
                        type="button"
                        disabled={Boolean(activeAction)}
                        onClick={() => void performAction(recording, "purge")}
                      >Delete forever</button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {nextCursor && (
          <button className="load-more" disabled={loading} onClick={() => void load(nextCursor)}>
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </section>
  );
}

function LibraryNavLink({
  view,
  activeView,
  label,
  children,
}: {
  view: LibraryView;
  activeView: LibraryView;
  label: string;
  children: React.ReactNode;
}) {
  const active = view === activeView;
  return (
    <Link
      className={active ? "active" : ""}
      href={view === "library" ? "/library" : `/library?view=${view}`}
      aria-current={active ? "page" : undefined}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">{children}</svg>
      {label}
    </Link>
  );
}
