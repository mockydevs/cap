"use client";

import { useEffect, useState } from "react";
import { formatDate, formatDuration } from "../lib/format/display";

type Engagement = {
  views: number;
  uniqueViewers: number;
  averageWatchTimeMs: number;
  completionRate: number;
  lastViewedAt: string | null;
  retention: Array<{ percent: number; viewers: number }>;
};

export function RecordingAnalytics({ recordingId }: { recordingId: string }) {
  const [data, setData] = useState<Engagement>();
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/recordings/${recordingId}/analytics`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("analytics unavailable");
        setData((await response.json()) as Engagement);
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError"))
          setError(true);
      });
    return () => controller.abort();
  }, [recordingId]);

  if (error)
    return <p className="analytics-empty">Engagement data is unavailable.</p>;
  if (!data) return <p className="analytics-empty">Loading engagement…</p>;

  const peak = Math.max(1, ...data.retention.map((point) => point.viewers));
  return (
    <section className="recording-analytics" aria-label="Recording engagement">
      <div className="analytics-summary">
        <Metric value={data.views} label="Views" />
        <Metric value={data.uniqueViewers} label="Viewers" />
        <Metric value={`${data.completionRate}%`} label="Completed" />
        <Metric
          value={formatDuration(data.averageWatchTimeMs) ?? "00:00"}
          label="Avg. watch"
        />
      </div>
      <div className="retention-heading">
        <div>
          <span className="eyebrow">Audience retention</span>
          <h2>Where attention holds</h2>
        </div>
        {data.lastViewedAt && (
          <small>Last viewed {formatDate(data.lastViewedAt)}</small>
        )}
      </div>
      {data.views === 0 ? (
        <p className="analytics-empty">
          Views will appear here after you share this recording.
        </p>
      ) : (
        <div
          className="retention-chart"
          aria-label="Viewer retention by video position"
        >
          {data.retention.map((point) => (
            <div className="retention-column" key={point.percent}>
              <span className="retention-value">{point.viewers}</span>
              <span className="retention-bar-shell">
                <i
                  style={{
                    height: `${Math.max(4, (point.viewers / peak) * 100)}%`,
                  }}
                />
              </span>
              <small>{point.percent}%</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Metric({ value, label }: { value: number | string; label: string }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
