"use client";
import { useCallback, useEffect, useState } from "react";
type Comment = {
  id: string;
  body: string;
  timestampMs: number;
  authorName: string;
  createdAt: string;
  canEdit: boolean;
  reactions: Record<string, { count: number; reacted: boolean }>;
};
const emojis = ["👍", "❤️", "🎉", "😂", "👀"] as const;
export function CommentThread({
  recordingId,
  timestampMs,
  share,
}: {
  recordingId: string;
  timestampMs: number;
  share?: { token: string; password: string };
}) {
  const [items, setItems] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [guestName, setGuestName] = useState("");
  const [viewerKey, setViewerKey] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!share) return;
    setGuestName(localStorage.getItem("cap-guest-name") ?? "");
    let key = localStorage.getItem("cap-viewer-key");
    if (!key) {
      key = crypto.randomUUID();
      localStorage.setItem("cap-viewer-key", key);
    }
    setViewerKey(key);
  }, [share]);
  const sharedBody = useCallback(
    (action: string, extra: object = {}) => ({
      action,
      guestName,
      viewerKey,
      password: share?.password || undefined,
      ...extra,
    }),
    [guestName, viewerKey, share],
  );
  const load = useCallback(async () => {
    if (share && (!guestName || !viewerKey)) return;
    const response = share
      ? await fetch(`/api/shares/${share.token}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sharedBody("list")),
        })
      : await fetch(`/api/recordings/${recordingId}/comments`);
    if (response.ok)
      setItems(((await response.json()) as { items: Comment[] }).items);
  }, [recordingId, share, guestName, viewerKey, sharedBody]);
  useEffect(() => {
    void load();
  }, [load]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (share) localStorage.setItem("cap-guest-name", guestName);
    const input = { body, timestampMs: Math.max(0, Math.floor(timestampMs)) };
    const response = share
      ? await fetch(`/api/shares/${share.token}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sharedBody("create", input)),
        })
      : await fetch(`/api/recordings/${recordingId}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
    if (!response.ok) {
      setError("Comment could not be added.");
      return;
    }
    setBody("");
    setError(undefined);
    await load();
  }
  async function react(commentId: string, emoji: string, active: boolean) {
    if (share)
      await fetch(`/api/shares/${share.token}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          sharedBody("reaction", { commentId, emoji, active }),
        ),
      });
    else
      await fetch(
        `/api/recordings/${recordingId}/comments/${commentId}/reactions`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji, active }),
        },
      );
    await load();
  }
  async function remove(commentId: string) {
    if (share)
      await fetch(`/api/shares/${share.token}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sharedBody("delete", { commentId })),
      });
    else
      await fetch(`/api/recordings/${recordingId}/comments/${commentId}`, {
        method: "DELETE",
      });
    await load();
  }
  async function edit(comment: Comment) {
    const next = window.prompt("Edit comment", comment.body)?.trim();
    if (!next || next === comment.body) return;
    if (share)
      await fetch(`/api/shares/${share.token}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          sharedBody("update", { commentId: comment.id, body: next }),
        ),
      });
    else
      await fetch(`/api/recordings/${recordingId}/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: next }),
      });
    await load();
  }
  return (
    <section className="comments">
      <header className="panel-heading">
        <div>
          <p className="eyebrow">Conversation</p>
          <h2>Comments</h2>
        </div>
        <span>{items.length}</span>
      </header>
      <form onSubmit={create} className="comment-form">
        {share && (
          <input
            aria-label="Your name"
            placeholder="Your name"
            required
            minLength={2}
            maxLength={80}
            value={guestName}
            onChange={(event) => setGuestName(event.target.value)}
          />
        )}
        <textarea
          aria-label="Comment"
          placeholder="Leave feedback at this moment…"
          required
          maxLength={2000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <button type="submit">
          Comment at {Math.floor(timestampMs / 60000)}:
          {String(Math.floor(timestampMs / 1000) % 60).padStart(2, "0")}
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <div className="comment-list">
        {items.map((comment) => (
          <article className="comment" key={comment.id}>
            <header>
              <strong>{comment.authorName}</strong>
              <span>
                {Math.floor(comment.timestampMs / 60000)}:
                {String(Math.floor(comment.timestampMs / 1000) % 60).padStart(
                  2,
                  "0",
                )}
              </span>
            </header>
            <p>{comment.body}</p>
            <footer>
              {emojis.map((emoji) => {
                const reaction = comment.reactions[emoji];
                return (
                  <button
                    type="button"
                    className={reaction?.reacted ? "reacted" : ""}
                    key={emoji}
                    onClick={() =>
                      void react(comment.id, emoji, !reaction?.reacted)
                    }
                  >
                    {emoji} {reaction?.count || ""}
                  </button>
                );
              })}
              {comment.canEdit && (
                <button type="button" onClick={() => void edit(comment)}>Edit</button>
              )}
              {comment.canEdit && (
                <button type="button" onClick={() => void remove(comment.id)}>Delete</button>
              )}
            </footer>
          </article>
        ))}
        {!items.length && (
          <div className="panel-empty">
            <span aria-hidden="true">00:00</span>
            <strong>Start the conversation.</strong>
            <p>Comments stay anchored to the moment you are watching.</p>
          </div>
        )}
      </div>
    </section>
  );
}
