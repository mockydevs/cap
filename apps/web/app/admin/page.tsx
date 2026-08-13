import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AdminPanel } from "../../components/admin-panel";
import { WorkspaceBar } from "../../components/workspace-bar";
import { actorFromToken, sessionCookieName } from "../../lib/auth/session";

export default async function AdminPage() {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const actor = await actorFromToken(token);
  if (!actor) redirect("/login");

  return (
    <main className="workspace">
      <WorkspaceBar current="settings" account={actor} showSearch={false} />
      <section className="admin-content">
        <header className="admin-heading">
          <h1>Workspace settings</h1>
        </header>
        {/* Section navigation lives in the panel, which owns the active tab. */}
        <AdminPanel />
      </section>
    </main>
  );
}
