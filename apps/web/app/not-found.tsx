import Link from "next/link";
import { WorkspaceMark } from "../components/workspace-mark";

export default function NotFound() {
  return (
    <main className="system-page">
      <header className="system-header">
        <WorkspaceMark href="/" />
        <span>404 / Not found</span>
      </header>
      <section className="system-card">
        <span className="state-code">404</span>
        <p className="eyebrow">Off timeline</p>
        <h1>There&apos;s nothing at this frame.</h1>
        <p>The page may have moved, or the link is no longer available.</p>
        <div className="state-actions">
          <Link className="state-primary" href="/">
            Back home
          </Link>
          <Link href="/library">Open library</Link>
        </div>
      </section>
    </main>
  );
}
