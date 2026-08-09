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
      {error && <p className="form-error">{error}</p>}
      <div className="ai-results">
        {items.map((item) => (
          <article key={item.id}>
            <strong>
              {item.capability.replaceAll("_", " ")} · {item.status}
            </strong>
            {item.content ? (
              <Artifact value={item.content} onSeek={onSeek} />
            ) : null}
            {item.errorCategory && (
              <p>Generation failed: {item.errorCategory}</p>
            )}
            {item.artifactStatus === "SUGGESTED" && (
              <div>
                <button onClick={() => void decide(item, "ACCEPTED")}>
                  Accept
                </button>
                <button onClick={() => void decide(item, "REJECTED")}>
                  Reject
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
function Artifact({
  value,
  onSeek,
}: {
  value: unknown;
  onSeek: (ms: number) => void;
}) {
  const content = value as Record<string, unknown>;
  if (Array.isArray(content.chapters))
    return (
      <ul>
        {(content.chapters as Array<{ startMs: number; title: string }>).map(
          (chapter) => (
            <li key={`${chapter.startMs}-${chapter.title}`}>
              <button onClick={() => onSeek(chapter.startMs)}>
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
              <button key={index} onClick={() => onSeek(citation.startMs)}>
                Evidence {index + 1}
              </button>
            ),
          )}
      </>
    );
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
