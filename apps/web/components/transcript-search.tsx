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
  async function search(event?: React.FormEvent, cursor?: string) {
    event?.preventDefault();
    if (query.trim().length < 2) return;
    const response = semantic
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
        semantic && code
          ? aiErrorMessage(code)
          : "Could not search workspace transcripts.",
      );
      setBlocked(semantic && isEntitlementDenial(code));
      return;
    }
    setError(undefined);
    setBlocked(false);
    const raw = (await response.json()) as {
      items: SearchHit[];
      nextCursor: string | null;
    };
    const page = semantic
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
  return (
    <section className="transcript-search">
      <form onSubmit={search}>
        <label>
          Search transcripts
          <input
            value={query}
            placeholder="Find a spoken phrase"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit">Search</button>
        <label className="search-mode">
          <input
            type="checkbox"
            checked={semantic}
            onChange={(event) => setSemantic(event.target.checked)}
          />
          Meaning-based AI search
        </label>
      </form>
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
        <>
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <Link href={`/library/${item.recordingId}?t=${item.startMs}`}>
                  <strong>{item.recordingTitle}</strong> · {item.text}
                </Link>
              </li>
            ))}
          </ul>
          {nextCursor ? (
            <button
              type="button"
              onClick={() => void search(undefined, nextCursor)}
            >
              More results
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
