import { AdminPanel } from "../../components/admin-panel";
import Link from "next/link";
export default function AdminPage() {
  return (
    <main className="admin-shell">
      <aside className="admin-nav">
        <Link className="sidebar-brand" href="/library">
          <span className="brand-mark" aria-hidden="true" />
          Cap
        </Link>
        <nav aria-label="Settings navigation">
          <a className="active" href="#workspace">
            Workspace
          </a>
          <a href="#members">Members</a>
          <a href="#integrations">Integrations</a>
          <a href="#security">Security</a>
        </nav>
        <Link href="/library">
          <span aria-hidden="true">←</span> Back to library
        </Link>
      </aside>
      <section className="admin-content" id="workspace">
        <header className="admin-heading">
          <div>
            <p className="eyebrow">Admin & settings</p>
            <h1>Workspace</h1>
            <p>
              Manage access, retention, integrations, and developer credentials.
            </p>
          </div>
          <span className="admin-status">
            <span aria-hidden="true" />
            Private workspace
          </span>
        </header>
        <AdminPanel />
      </section>
    </main>
  );
}
