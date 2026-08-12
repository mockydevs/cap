"use client";
import { useCallback, useEffect, useState } from "react";
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
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch(`/api/recordings/${recordingId}/ai`, {
      cache: "no-store",
    });
    if (response.ok)
      setItems(((await response.json()) as { items: Item[] }).items);
  }, [recordingId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);
  const request = async (capability: string) => {
    setBusy(true);
    setError(undefined);
    const response = await fetch(`/api/recordings/${recordingId}/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability,
        ...(capability === "QUESTIONS_ANSWERS" ? { question } : {}),
        ...(capability === "TRANSLATION" ? { targetLanguage } : {}),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      setError(body.error?.code ?? "AI request failed");
      return;
    }
    setQuestion("");
    await load();
  };
  const decide = async (item: Item, status: "ACCEPTED" | "REJECTED") => {
    await fetch(
      `/api/recordings/${recordingId}/ai/artifacts/${item.artifactId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      },
    );
    await load();
  };
  return (
    <section className="ai-panel">
      <p className="eyebrow">AI ASSISTANT</p>
      <h2>Recording intelligence</h2>
      <p>Generated output is a suggestion. Review it before accepting.</p>
      <div className="ai-actions">
        {capabilities.map((capability) => (
          <button
            type="button"
            disabled={busy}
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
        <button disabled={busy}>Ask</button>
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
        <button disabled={busy}>Translate</button>
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
                <button type="button" onClick={() => void decide(item, "ACCEPTED")}>
                  Accept
                </button>
                <button type="button" onClick={() => void decide(item, "REJECTED")}>
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
            <p>Choose an action above to turn the transcript into useful output.</p>
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
              <button type="button" key={index} onClick={() => onSeek(citation.startMs)}>
                Evidence {index + 1}
              </button>
            ),
          )}
      </>
    );
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
