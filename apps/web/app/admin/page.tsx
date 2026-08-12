import { AdminPanel } from "../../components/admin-panel";
import Link from "next/link";
export default function AdminPage() {
  return (
    <main className="admin-shell">
      <aside className="admin-nav">
        <Link className="sidebar-brand" href="/library"><span className="brand-mark" aria-hidden="true" />Cap</Link>
        <nav aria-label="Settings navigation">
          <span className="active">Workspace</span>
          <span>Members</span>
          <span>Integrations</span>
          <span>Security</span>
        </nav>
        <Link href="/library">← Back to library</Link>
      </aside>
      <section className="admin-content">
        <header className="admin-heading">
          <p className="eyebrow">Admin & settings</p>
          <h1>Workspace</h1>
          <p>Manage access, retention, integrations, and developer credentials.</p>
        </header>
        <AdminPanel />
      </section>
    </main>
  );
}
