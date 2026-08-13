import Link from "next/link";
import { AdminPanel } from "../../components/admin-panel";

export default function AdminPage() {
  return (
    <main className="admin-shell">
      <aside className="admin-nav">
        <Link className="sidebar-brand" href="/library">
          <span className="brand-mark" aria-hidden="true" />
          Cap
        </Link>
        <Link href="/library">
          <span aria-hidden="true">←</span> Back to library
        </Link>
      </aside>
      <section className="admin-content">
        <header className="admin-heading">
          <h1>Settings</h1>
          <span className="admin-status">
            <span aria-hidden="true" />
            Private workspace
          </span>
        </header>
        {/* Section navigation lives in the panel, which owns the active tab. */}
        <AdminPanel />
      </section>
    </main>
  );
}
