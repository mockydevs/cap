"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchFresh, sendJson } from "../lib/http/json";
import {
  aiErrorMessage,
  isEntitlementDenial,
  type WorkspaceEntitlements,
} from "../lib/ai/messages";
type Item = {
  id: string;
  capability: string;
  status: string;
  errorCategory: string | null;
  artifactId: string | null;
  artifactStatus: string | null;
  content: unknown;
};
const capabilities = [
  "TITLE_DESCRIPTION",
  "SUMMARY",
  "CHAPTERS",
  "ACTION_ITEMS",
  "HIGHLIGHTS",
  "FOLLOW_UP",
  "SENSITIVE_DATA",
] as const;
export function AiPanel({
  recordingId,
  onSeek,
}: {
  recordingId: string;
  onSeek: (ms: number) => void;
}) {
  const [items, setItems] = useState<Item[]>([]),
    [question, setQuestion] = useState(""),
    [targetLanguage, setTargetLanguage] = useState(""),
    [error, setError] = useState<string>(),
    [blocked, setBlocked] = useState<string>(),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetchFresh(`/api/recordings/${recordingId}/ai`);
    if (response.ok)
      setItems(((await response.json()) as { items: Item[] }).items);
  }, [recordingId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);
  // Asked once up front so a workspace with no way to pay is told before it
  // clicks, rather than after a request it was never going to be allowed.
  useEffect(() => {
    void fetchFresh("/api/ai/entitlement").then(async (response) => {
      if (!response.ok) return;
      const payload = (await response.json()) as WorkspaceEntitlements;
      setBlocked(
        payload.analysis.lane === "NONE" ? payload.analysis.reason : undefined,
      );
    });
  }, []);
  const request = async (capability: string) => {
    setBusy(true);
    setError(undefined);
    const response = await sendJson(
      `/api/recordings/${recordingId}/ai`,
      "POST",
      {
        capability,
        ...(capability === "QUESTIONS_ANSWERS" ? { question } : {}),
        ...(capability === "TRANSLATION" ? { targetLanguage } : {}),
      },
    );
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      const code = body.error?.code;
      setError(aiErrorMessage(code));
      if (isEntitlementDenial(code)) setBlocked(code);
      return;
    }
    setQuestion("");
    await load();
  };
  const decide = async (item: Item, status: "ACCEPTED" | "REJECTED") => {
    await sendJson(
      `/api/recordings/${recordingId}/ai/artifacts/${item.artifactId}`,
      "PATCH",
      { status },
    );
    await load();
  };
  return (
    <section className="ai-panel">
      <header className="panel-heading">
        <div>
          <p className="eyebrow">AI assistant</p>
          <h2>Recording intelligence</h2>
        </div>
      </header>
      <p className="panel-lede">
        Generated output is a suggestion. Review it before accepting.
      </p>
      {/* Switched-off AI is a workspace setting, not a failure, so it reads as
          a note rather than wearing the error treatment. */}
      {blocked && (
        <p className="panel-notice">
          {aiErrorMessage(blocked)}{" "}
          <Link href="/admin#ai">Open AI settings</Link>
        </p>
      )}
      <div className="ai-actions">
        {capabilities.map((capability) => (
          <button
            type="button"
            disabled={busy || Boolean(blocked)}
            key={capability}
            onClick={() => void request(capability)}
          >
            {capability.replaceAll("_", " ").toLowerCase()}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void request("QUESTIONS_ANSWERS");
        }}
      >
        <input
          value={question}
          minLength={2}
          maxLength={2000}
          required
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask a question grounded in this transcript"
        />
        <button disabled={busy || Boolean(blocked)}>Ask</button>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void request("TRANSLATION");
        }}
      >
        <input
          value={targetLanguage}
          pattern="[a-z]{2,3}(-[A-Z]{2})?"
          required
          onChange={(event) => setTargetLanguage(event.target.value)}
          placeholder="Target language (e.g. es, fr, pt-BR)"
        />
        <button disabled={busy || Boolean(blocked)}>Translate</button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <div className="ai-results">
        {items.map((item) => (
          <article key={item.id}>
            <strong>
              {item.capability.replaceAll("_", " ")} · {item.status}
            </strong>
            {item.content ? (
              <Artifact
                value={item.content}
                onSeek={onSeek}
                recordingId={recordingId}
              />
            ) : null}
            {item.errorCategory && (
              <p>Generation failed: {item.errorCategory}</p>
            )}
            {item.artifactStatus === "SUGGESTED" && (
              <div>
                <button
                  type="button"
                  onClick={() => void decide(item, "ACCEPTED")}
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => void decide(item, "REJECTED")}
                >
                  Reject
                </button>
              </div>
            )}
          </article>
        ))}
        {!items.length && (
          <div className="panel-empty ai-empty">
            <span aria-hidden="true">AI</span>
            <strong>No generated insights yet.</strong>
            <p>
              Choose an action above to turn the transcript into useful output.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
function Artifact({
  value,
  onSeek,
  recordingId,
}: {
  value: unknown;
  onSeek: (ms: number) => void;
  recordingId: string;
}) {
  const content = value as Record<string, unknown>;
  if (typeof content.language === "string" && typeof content.text === "string")
    return (
      <>
        <p>{content.text}</p>
        {Array.isArray(content.segments) && content.segments.length > 0 && (
          <p>
            Captions:{" "}
            <a
              href={`/api/recordings/${recordingId}/captions?language=${content.language}&format=vtt`}
            >
              WebVTT
            </a>{" "}
            ·{" "}
            <a
              href={`/api/recordings/${recordingId}/captions?language=${content.language}&format=srt`}
            >
              SRT
            </a>
          </p>
        )}
      </>
    );
  if (Array.isArray(content.chapters))
    return (
      <ul>
        {(content.chapters as Array<{ startMs: number; title: string }>).map(
          (chapter) => (
            <li key={`${chapter.startMs}-${chapter.title}`}>
              <button type="button" onClick={() => onSeek(chapter.startMs)}>
                {chapter.title}
              </button>
            </li>
          ),
        )}
      </ul>
    );
  if (typeof content.answer === "string")
    return (
      <>
        <p>{content.answer}</p>
        {Array.isArray(content.citations) &&
          (content.citations as Array<{ startMs: number }>).map(
            (citation, index) => (
              <button
                type="button"
                key={index}
                onClick={() => onSeek(citation.startMs)}
              >
                Evidence {index + 1}
              </button>
            ),
          )}
      </>
    );
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
