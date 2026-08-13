import { WorkspaceMark } from "../components/workspace-mark";

export default function Loading() {
  return (
    <main className="system-page" aria-live="polite">
      <header className="system-header">
        <WorkspaceMark href="/" />
        <span>Loading</span>
      </header>
      <section className="system-card system-card-loading">
        <span className="state-loader" aria-hidden="true" />
        <p className="eyebrow">One moment</p>
        <h1>Getting things ready.</h1>
        <p>Loading the next part of your workspace…</p>
      </section>
    </main>
  );
}
