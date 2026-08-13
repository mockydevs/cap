"use client";

import Link from "next/link";
import { useState } from "react";
import { sendJson } from "../lib/http/json";
import { aiErrorMessage, isEntitlementDenial } from "../lib/ai/messages";

type SearchHit = {
  id: string;
  recordingId: string;
  recordingTitle: string;
  startMs: number;
  text: string;
};

export function TranscriptSearch() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>();
  const [error, setError] = useState<string>();
  const [blocked, setBlocked] = useState(false);
  const [semantic, setSemantic] = useState(false);
  async function search(
    event?: React.FormEvent,
    cursor?: string,
    // Explicit so flipping the AI toggle can re-run the query in the new mode
    // without waiting for the state update to land.
    mode = semantic,
  ) {
    event?.preventDefault();
    if (query.trim().length < 2) return;
    const response = mode
      ? await sendJson("/api/ai/search", "POST", {
          query: query.trim(),
          limit: 10,
        })
      : await fetch(
          `/api/transcripts/search?q=${encodeURIComponent(query.trim())}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
    if (!response.ok) {
      // Meaning-based search bills the workspace like any other AI feature, so
      // an entitlement denial has to say what to do about it rather than read
      // as a generic search failure.
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      const code = body.error?.code;
      setError(
        mode && code
          ? aiErrorMessage(code)
          : "Could not search workspace transcripts.",
      );
      setBlocked(mode && isEntitlementDenial(code));
      return;
    }
    setError(undefined);
    setBlocked(false);
    const raw = (await response.json()) as {
      items: SearchHit[];
      nextCursor: string | null;
    };
    const page = mode
      ? {
          items: raw.items.map(
            (item: SearchHit & { title?: string }, index: number) => ({
              ...item,
              id:
                item.id ??
                `semantic-${item.recordingId}-${item.startMs}-${index}`,
              recordingTitle: item.recordingTitle ?? item.title ?? "Recording",
            }),
          ),
          nextCursor: null,
        }
      : raw;
    setItems((current) => (cursor ? [...current, ...page.items] : page.items));
    setNextCursor(page.nextCursor);
  }
  // Results hang below the field as a panel so the search can live in the
  // workspace bar without pushing the page around.
  const open = Boolean(items.length || error);
  return (
    <div className="transcript-search">
      <form onSubmit={search} role="search">
        <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <label htmlFor="workspace-search">Search transcripts</label>
        <input
          id="workspace-search"
          value={query}
          placeholder="Search transcripts…"
          onChange={(event) => setQuery(event.target.value)}
        />
        {open ? (
          <button
            className="search-clear"
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setItems([]);
              setError(undefined);
              setBlocked(false);
            }}
          >
            ✕
          </button>
        ) : null}
      </form>
      {open ? (
        <div className="search-results">
          <div className="search-results-head">
            <span>
              {items.length
                ? `${items.length} result${items.length === 1 ? "" : "s"}`
                : "No results"}
            </span>
            <label className="search-mode">
              <input
                type="checkbox"
                checked={semantic}
                onChange={(event) => {
                  setSemantic(event.target.checked);
                  void search(undefined, undefined, event.target.checked);
                }}
              />
              AI search
            </label>
          </div>
          {error ? (
            <p className="form-error">
              {error}
              {blocked ? (
                <>
                  {" "}
                  <Link href="/admin#ai">Open AI settings</Link>
                </>
              ) : null}
            </p>
          ) : null}
          {items.length ? (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <Link href={`/library/${item.recordingId}?t=${item.startMs}`}>
                    <strong>{item.recordingTitle}</strong>
                    <span>{item.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {nextCursor ? (
            <button
              className="btn-secondary"
              type="button"
              onClick={() => void search(undefined, nextCursor)}
            >
              More results
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
