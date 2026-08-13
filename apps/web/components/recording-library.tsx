"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatBytes,
  formatCount,
  formatDate,
  formatDuration,
  formatViews,
  initialsOf,
} from "../lib/format/display";
import { fetchFresh } from "../lib/http/json";

type LibraryView = "library" | "shared" | "starred" | "trash";
type RecordingStatus =
  "UPLOADING" | "PROCESSING" | "READY" | "FAILED" | "DELETED";
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
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  isStarred: boolean;
  canDelete: boolean;
  viewCount: number;
};
type Page = { items: RecordingSummary[]; nextCursor: string | null };
type Overview = {
  stats: {
    recordings: number;
    views: number;
    transcribed: number;
    storageBytes: number;
  };
  featured: {
    id: string;
    title: string;
    ownerName: string;
    createdAt: string;
    durationMs: number | null;
    views: number;
    resumeAtMs: number | null;
  } | null;
};

const STALLED_UPLOAD_AFTER_MS = 15 * 60 * 1_000;

export function isUploadStalled(
  recording: Pick<RecordingSummary, "status" | "updatedAt">,
  now = Date.now(),
): boolean {
  return (
    recording.status === "UPLOADING" &&
    now - new Date(recording.updatedAt).getTime() >= STALLED_UPLOAD_AFTER_MS
  );
}

const viewContent: Record<
  LibraryView,
  { title: string; emptyTitle: string; emptyBody: string }
> = {
  library: {
    title: "Recent recordings",
    emptyTitle: "No recordings yet",
    emptyBody: "Your first walkthrough is one click away.",
  },
  shared: {
    title: "Shared with me",
    emptyTitle: "Nothing shared",
    emptyBody: "Recordings your teammates share land here.",
  },
  starred: {
    title: "Starred",
    emptyTitle: "No starred recordings",
    emptyBody: "Star a recording to keep it within reach.",
  },
  trash: {
    title: "Trash",
    emptyTitle: "Trash is empty",
    emptyBody: "Deleted recordings wait here before they are purged.",
  },
};

export function RecordingLibrary({
  initialView,
}: {
  initialView: LibraryView;
}) {
  const router = useRouter();
  const [items, setItems] = useState<RecordingSummary[]>([]);
  const [overview, setOverview] = useState<Overview>();
  const [nextCursor, setNextCursor] = useState<string | null>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [activeAction, setActiveAction] = useState<string>();
  const content = viewContent[initialView];
  // The hero and the ribbon summarise the whole workspace, so they belong to
  // the workspace's own view rather than to a filtered slice of it.
  const isHome = initialView === "library";

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
      setItems((current) =>
        cursor ? [...current, ...page.items] : page.items,
      );
      setNextCursor(page.nextCursor);
      setLoading(false);
    },
    [initialView, router],
  );

  const loadOverview = useCallback(async () => {
    if (!isHome) return;
    const response = await fetchFresh("/api/workspace/overview");
    if (response.ok) setOverview((await response.json()) as Overview);
  }, [isHome]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

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
    await loadOverview();
  }

  const processingCount = items.filter((item) => {
    const status = effectiveStatus(item);
    return status === "PROCESSING" || status === "UPLOADING";
  }).length;

  return (
    <>
      {isHome && overview?.featured && (
        <FeaturedRecording featured={overview.featured} />
      )}
      {isHome && overview && <StatsRibbon stats={overview.stats} />}
      <section className="workspace-wall">
        <div className="wall-heading">
          <h1>{content.title}</h1>
          {initialView !== "trash" && (
            <nav className="wall-filters" aria-label="Recording filters">
              {(
                [
                  ["ALL", "All", items.length],
                  [
                    "READY",
                    "Ready",
                    items.filter((item) => effectiveStatus(item) === "READY")
                      .length,
                  ],
                  ["PROCESSING", "Processing", processingCount],
                  [
                    "FAILED",
                    "Failed",
                    items.filter((item) => effectiveStatus(item) === "FAILED")
                      .length,
                  ],
                ] as const
              ).map(([filter, label, total]) => (
                <button
                  key={filter}
                  type="button"
                  className={`tag${statusFilter === filter ? " tag-active" : ""}`}
                  aria-pressed={statusFilter === filter}
                  onClick={() => setStatusFilter(filter)}
                >
                  {label}
                  <em>{total}</em>
                </button>
              ))}
            </nav>
          )}
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {!loading && items.length === 0 && (
          <div className="empty-state">
            <h2>{content.emptyTitle}</h2>
            <p>{content.emptyBody}</p>
            {initialView === "library" ? (
              <Link className="btn" href="/record">
                <span className="record-dot" aria-hidden="true" />
                Start recording
              </Link>
            ) : (
              <Link className="btn btn-secondary" href="/library">
                Return to library
              </Link>
            )}
          </div>
        )}

        {!loading && items.length > 0 && filteredItems.length === 0 && (
          <div className="library-filter-empty">
            <strong>No recordings match this filter.</strong>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => setStatusFilter("ALL")}
            >
              Show all
            </button>
          </div>
        )}

        <div className="recording-grid">
          {filteredItems.map((recording) => {
            const status = effectiveStatus(recording);
            const uploadStalled = isUploadStalled(recording);
            const duration = formatDuration(recording.durationMs);
            const cardContent = (
              <>
                <div
                  className={`recording-art${uploadStalled ? " recording-art-stalled" : ""}`}
                >
                  {status === "READY" && (
                    <span className="play-mark" aria-hidden="true">
                      <PlayGlyph />
                    </span>
                  )}
                  {status !== "READY" && (
                    <span
                      className={`recording-status status-${status.toLowerCase()}`}
                    >
                      {recording.status === "DELETED" ? "TRASHED" : status}
                    </span>
                  )}
                  {duration && status === "READY" && (
                    <span className="thumb-time">{duration}</span>
                  )}
                  {(status === "UPLOADING" || status === "PROCESSING") && (
                    <div className="recording-progress">
                      <div className="recording-progress-copy">
                        <strong>
                          {uploadStalled
                            ? "Upload interrupted"
                            : status === "UPLOADING"
                              ? "Uploading"
                              : "Processing media"}
                        </strong>
                        <span>
                          {uploadStalled
                            ? "Check New recording for recovery"
                            : status === "UPLOADING"
                              ? "Keep the recording tab open"
                              : "This updates automatically"}
                        </span>
                      </div>
                      <div
                        className={`recording-progress-track${uploadStalled ? " is-stalled" : ""}`}
                        role="progressbar"
                        aria-label={
                          uploadStalled
                            ? "Upload interrupted"
                            : `${status === "UPLOADING" ? "Upload" : "Processing"} in progress`
                        }
                      >
                        <span />
                      </div>
                    </div>
                  )}
                  {status === "FAILED" && (
                    <span className="recording-failed-mark" aria-hidden="true">
                      !
                    </span>
                  )}
                </div>
                <div className="recording-card-copy">
                  <h2>{recording.title}</h2>
                  <p>
                    {initialView === "shared" && (
                      <>
                        <span>{recording.ownerName}</span>
                        <i aria-hidden="true">·</i>
                      </>
                    )}
                    <span>
                      {recording.status === "DELETED" && recording.deletedAt
                        ? `Deleted ${formatDate(recording.deletedAt)}`
                        : formatDate(recording.createdAt)}
                    </span>
                    <i aria-hidden="true">·</i>
                    <span>{formatViews(recording.viewCount)}</span>
                  </p>
                </div>
              </>
            );
            return (
              <article className="recording-card" key={recording.id}>
                {initialView === "trash" ? (
                  <div className="recording-card-content">{cardContent}</div>
                ) : (
                  <Link
                    className="recording-card-content"
                    href={`/library/${recording.id}`}
                  >
                    {cardContent}
                  </Link>
                )}
                <div
                  className={`recording-card-actions recording-card-actions-${initialView}`}
                >
                  {initialView !== "trash" && (
                    <button
                      type="button"
                      className={recording.isStarred ? "is-starred" : ""}
                      disabled={Boolean(activeAction)}
                      aria-label={
                        recording.isStarred
                          ? `Remove star from ${recording.title}`
                          : `Star ${recording.title}`
                      }
                      title={
                        recording.isStarred
                          ? "Remove from starred"
                          : "Add to starred"
                      }
                      onClick={() =>
                        void performAction(
                          recording,
                          recording.isStarred ? "unstar" : "star",
                        )
                      }
                    >
                      <svg aria-hidden="true" viewBox="0 0 24 24">
                        <path d="m12 3 2.5 5.5 6 .5-4.5 4 1.4 6L12 16l-5.4 3L8 13 3.5 9l6-.5Z" />
                      </svg>
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
                      <svg aria-hidden="true" viewBox="0 0 24 24">
                        <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" />
                      </svg>
                    </button>
                  )}
                  {initialView === "trash" && recording.canDelete && (
                    <>
                      <button
                        className="btn-secondary"
                        type="button"
                        disabled={Boolean(activeAction)}
                        onClick={() => void performAction(recording, "restore")}
                      >
                        Restore
                      </button>
                      <button
                        className="recording-purge"
                        type="button"
                        disabled={Boolean(activeAction)}
                        onClick={() => void performAction(recording, "purge")}
                      >
                        Delete forever
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {nextCursor && (
          <button
            className="load-more btn-secondary"
            disabled={loading}
            onClick={() => void load(nextCursor)}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </>
  );
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function FeaturedRecording({
  featured,
}: {
  featured: NonNullable<Overview["featured"]>;
}) {
  const [copied, setCopied] = useState(false);
  const duration = formatDuration(featured.durationMs);
  const resumeAt = formatDuration(featured.resumeAtMs);
  const progress =
    featured.resumeAtMs && featured.durationMs
      ? Math.min(100, (featured.resumeAtMs / featured.durationMs) * 100)
      : 0;
  const href = featured.resumeAtMs
    ? `/library/${featured.id}?t=${featured.resumeAtMs}`
    : `/library/${featured.id}`;

  async function copyLink() {
    await navigator.clipboard.writeText(
      new URL(`/library/${featured.id}`, window.location.origin).toString(),
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <section className="workspace-hero">
      <Link className="hero-art" href={href}>
        <span className="play-mark play-mark-lg" aria-hidden="true">
          <PlayGlyph />
        </span>
        <span className="hero-flag">
          {featured.resumeAtMs ? "Continue watching" : "Latest recording"}
        </span>
        {duration && (
          <span className="thumb-time">
            {resumeAt ? `${resumeAt} / ${duration}` : duration}
          </span>
        )}
        {progress > 0 && (
          <span className="hero-progress" aria-hidden="true">
            <i style={{ width: `${progress}%` }} />
          </span>
        )}
      </Link>
      <div className="hero-copy">
        <h2>{featured.title}</h2>
        <p className="hero-meta">
          <span className="avatar avatar-sm" aria-hidden="true">
            {initialsOf(featured.ownerName)}
          </span>
          <span>{featured.ownerName}</span>
          <i aria-hidden="true">·</i>
          <span>{formatDate(featured.createdAt)}</span>
          <i aria-hidden="true">·</i>
          <span>{formatViews(featured.views)}</span>
        </p>
        <div className="hero-actions">
          <Link className="btn" href={href}>
            <PlayGlyph />
            {featured.resumeAtMs ? "Resume" : "Play"}
          </Link>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => void copyLink()}
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
      </div>
    </section>
  );
}

function StatsRibbon({ stats }: { stats: Overview["stats"] }) {
  const cells: [string, string][] = [
    [formatCount(stats.recordings), "Recordings"],
    [formatCount(stats.views), "Total views"],
    [formatCount(stats.transcribed), "Transcribed"],
    [formatBytes(stats.storageBytes), "Storage"],
  ];
  return (
    <dl className="workspace-stats">
      {cells.map(([value, label]) => (
        <div key={label}>
          <dd>{value}</dd>
          <dt>{label}</dt>
        </div>
      ))}
    </dl>
  );
}
