import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { EditorStudio } from "../../../../components/editor-studio";
import { WorkspaceBar } from "../../../../components/workspace-bar";
import {
  actorFromToken,
  sessionCookieName,
} from "../../../../lib/auth/session";

export default async function EditorPage({
  params,
}: {
  params: Promise<{ recordingId: string }>;
}) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const actor = await actorFromToken(token);
  if (!actor) redirect("/login");

  return (
    <main className="workspace">
      <WorkspaceBar current="library" account={actor} showSearch={false} />
      <EditorStudio recordingId={(await params).recordingId} />
    </main>
  );
}
