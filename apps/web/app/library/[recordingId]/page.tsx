import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { RecordingViewer } from "../../../components/recording-viewer";
import { WorkspaceBar } from "../../../components/workspace-bar";
import { actorFromToken, sessionCookieName } from "../../../lib/auth/session";

export default async function RecordingPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordingId: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const actor = await actorFromToken(token);
  if (!actor) redirect("/login");

  const query = await searchParams;
  const timestamp = Number(query.t);
  return (
    <main className="workspace">
      <WorkspaceBar current="library" account={actor} />
      <RecordingViewer
        recordingId={(await params).recordingId}
        {...(Number.isSafeInteger(timestamp) && timestamp >= 0
          ? { initialTimestampMs: timestamp }
          : {})}
      />
    </main>
  );
}
