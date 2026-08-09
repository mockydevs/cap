"use client";

import { useCallback, useEffect, useState } from "react";

type Segment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
};
type TranscriptPage = {
  transcript: {
    id: string;
    language: string | null;
    correctionRevision: number;
  } | null;
  items: Segment[];
  nextCursor: string | null;
};

function cueTime(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function TranscriptPanel({
  recordingId,
  onSeek,
}: {
  recordingId: string;
  onSeek: (timestampMs: number) => void;
}) {
  const [page, setPage] = useState<TranscriptPage>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [language, setLanguage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/recordings/${recordingId}/transcript`, {
      cache: "no-store",
    });
    if (response.status === 404) {
      setPage({ transcript: null, items: [], nextCursor: null });
      return;
    }
    if (!response.ok) {
      setError("Transcript is unavailable.");
      return;
    }
    const next = (await response.json()) as TranscriptPage;
    setPage(next);
    setLanguage(next.transcript?.language ?? "");
  }, [recordingId]);
  useEffect(() => void load(), [load]);

  async function saveLanguage() {
    const response = await fetch(`/api/recordings/${recordingId}/transcript`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: language || null }),
    });
    if (!response.ok) {
      setError("Could not update transcript language.");
      return;
    }
    await load();
  }

  async function saveSegment(
    segment: Segment,
    text: string,
    speakerLabel: string,
  ) {
    setSaving(segment.id);
    setError(undefined);
    const response = await fetch(
      `/api/recordings/${recordingId}/transcript/segments/${segment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          speakerLabel: speakerLabel || null,
          expectedCorrectionRevision: page?.transcript?.correctionRevision,
        }),
      },
    );
    setSaving(undefined);
    if (!response.ok) {
      setError("Could not save that transcript correction.");
      return;
    }
    await load();
  }

  if (!page)
    return <section className="transcript-panel">Loading transcript…</section>;
  if (!page.transcript)
    return (
      <section className="transcript-panel">
        <h2>Transcript</h2>
        <p className="hint">
          A transcript will appear here when transcription is complete.
        </p>
      </section>
    );
  return (
    <section className="transcript-panel" aria-label="Transcript">
      <header className="transcript-heading">
        <div>
          <h2>Transcript</h2>
          <div className="transcript-language">
            <label>
              Language
              <input
                value={language}
                placeholder="en-US"
                onChange={(event) => setLanguage(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="nav-link"
              onClick={() => void saveLanguage()}
            >
              Save language
            </button>
          </div>
        </div>
        <div className="transcript-exports">
          <a
            href={`/api/recordings/${recordingId}/captions?format=vtt`}
            download
          >
            WebVTT
          </a>
          <a
            href={`/api/recordings/${recordingId}/captions?format=srt`}
            download
          >
            SRT
          </a>
        </div>
      </header>
      {error ? <p className="form-error">{error}</p> : null}
      <ol className="transcript-segments">
        {page.items.map((segment) => (
          <li key={segment.id}>
            <button type="button" onClick={() => onSeek(segment.startMs)}>
              {cueTime(segment.startMs)}
            </button>
            <TranscriptSegmentEditor
              segment={segment}
              disabled={saving === segment.id}
              onSave={saveSegment}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function TranscriptSegmentEditor({
  segment,
  disabled,
  onSave,
}: {
  segment: Segment;
  disabled: boolean;
  onSave: (
    segment: Segment,
    text: string,
    speakerLabel: string,
  ) => Promise<void>;
}) {
  const [text, setText] = useState(segment.text);
  const [speakerLabel, setSpeakerLabel] = useState(segment.speakerLabel ?? "");
  useEffect(() => {
    setText(segment.text);
    setSpeakerLabel(segment.speakerLabel ?? "");
  }, [segment]);
  return (
    <form
      className="transcript-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(segment, text, speakerLabel);
      }}
    >
      <input
        aria-label="Speaker label"
        value={speakerLabel}
        placeholder="Speaker"
        onChange={(event) => setSpeakerLabel(event.target.value)}
      />
      <textarea
        aria-label="Transcript text"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button disabled={disabled} type="submit">
        {disabled ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
