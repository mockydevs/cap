import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CaptureStudio } from "../../components/capture-studio";
import { WorkspaceBar } from "../../components/workspace-bar";
import { actorFromToken, sessionCookieName } from "../../lib/auth/session";

export const metadata: Metadata = {
  title: "New recording — Cap",
};

export default async function RecordPage() {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const actor = await actorFromToken(token);
  if (!actor) redirect("/login");

  return (
    <main className="workspace">
      <WorkspaceBar current="record" account={actor} showSearch={false} />
      <div className="record-workspace">
        <CaptureStudio />
      </div>
    </main>
  );
}
