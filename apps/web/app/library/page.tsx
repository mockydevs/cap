import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { RecordingLibrary } from "../../components/recording-library";
import { WorkspaceBar } from "../../components/workspace-bar";
import { actorFromToken, sessionCookieName } from "../../lib/auth/session";

const views = ["library", "shared", "starred", "trash"] as const;

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const actor = await actorFromToken(token);
  if (!actor) redirect("/login");

  const requestedView = (await searchParams).view;
  const view =
    views.find((candidate) => candidate === requestedView) ?? "library";
  return (
    <main className="workspace">
      <WorkspaceBar current={view} account={actor} />
      <RecordingLibrary key={view} initialView={view} />
    </main>
  );
}
