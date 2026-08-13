"use client";

import Link from "next/link";
import { WorkspaceMark } from "../components/workspace-mark";
import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="system-page">
      <header className="system-header">
        <WorkspaceMark href="/" />
        <span>Application error</span>
      </header>
      <section className="system-card">
        <span className="state-mark" aria-hidden="true">
          !
        </span>
        <p className="eyebrow">Something went wrong</p>
        <h1>That page hit a snag.</h1>
        <p>
          Your recordings are safe. Retry the page or return to your library.
        </p>
        <div className="state-actions">
          <button type="button" onClick={reset}>
            Try again
          </button>
          <Link href="/library">Go to library</Link>
        </div>
      </section>
    </main>
  );
}
