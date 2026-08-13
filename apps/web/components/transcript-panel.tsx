"use client";

import { formatDuration } from "@cap/recording";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchFresh, sendJson } from "../lib/http/json";
import { aiErrorMessage, isEntitlementDenial } from "../lib/ai/messages";

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
    status: string;
    correctionRevision: number;
  } | null;
  items: Segment[];
  nextCursor: string | null;
};

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
  const [requesting, setRequesting] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [language, setLanguage] = useState("");
  const load = useCallback(async () => {
    const response = await fetchFresh(
      `/api/recordings/${recordingId}/transcript`,
    );
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

  async function requestTranscription() {
    setRequesting(true);
    setError(undefined);
    const response = await sendJson(
      `/api/recordings/${recordingId}/transcript`,
      "POST",
    );
    setRequesting(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      const code = body.error?.code;
      setError(
        code === "RECORDING_NOT_READY"
          ? "This recording is still processing. Try again once it is ready."
          : aiErrorMessage(code),
      );
      setBlocked(isEntitlementDenial(code));
      return;
    }
    setBlocked(false);
    await load();
  }

  /** Offered whenever there is nothing to show and nothing on its way: no
   * transcript at all, or one disabled because the workspace could not pay
   * for AI when the recording was made. */
  function transcribeAction(title: string, detail: string) {
    return (
      <section className="transcript-panel">
        <div className="panel-empty">
          <span aria-hidden="true">TXT</span>
          <strong>{title}</strong>
          {detail ? <p>{detail}</p> : null}
          <button
            type="button"
            disabled={requesting}
            onClick={() => void requestTranscription()}
          >
            {requesting ? "Requesting…" : "Transcribe"}
          </button>
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
        </div>
      </section>
    );
  }

  async function saveLanguage() {
    const response = await sendJson(
      `/api/recordings/${recordingId}/transcript`,
      "PATCH",
      { language: language || null },
    );
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
    const response = await sendJson(
      `/api/recordings/${recordingId}/transcript/segments/${segment.id}`,
      "PATCH",
      {
        text,
        speakerLabel: speakerLabel || null,
        expectedCorrectionRevision: page?.transcript?.correctionRevision,
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
    return (
      <section className="transcript-panel" aria-live="polite">
        <div className="panel-empty panel-loading">
          <span className="state-loader" aria-hidden="true" />
          <strong>Loading transcript.</strong>
          <p>Aligning words with the recording timeline…</p>
        </div>
      </section>
    );
  if (!page.transcript) return transcribeAction("No transcript", "");
  if (page.transcript.status === "DISABLED")
    return transcribeAction(
      "Transcription is not switched on.",
      "This recording was made while the workspace had no AI provider connected. Connect one, then transcribe.",
    );
  if (page.transcript.status === "FAILED")
    return transcribeAction(
      "Transcription failed.",
      "The provider did not return a transcript for this recording. You can try again.",
    );
  if (page.transcript.status !== "READY")
    return (
      <section className="transcript-panel">
        <div className="panel-empty">
          <span aria-hidden="true">TXT</span>
          <strong>Processing transcript</strong>
        </div>
      </section>
    );
  return (
    <section className="transcript-panel" aria-label="Transcript">
      <header className="transcript-heading">
        <div>
          <p className="eyebrow">Words &amp; captions</p>
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
              {formatDuration(segment.startMs)}
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
