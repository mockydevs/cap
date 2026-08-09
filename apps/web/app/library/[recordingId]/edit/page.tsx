import { EditorStudio } from "../../../../components/editor-studio";

export default async function EditorPage({
  params,
}: {
  params: Promise<{ recordingId: string }>;
}) {
  return (
    <main className="editor-page">
      <EditorStudio recordingId={(await params).recordingId} />
    </main>
  );
}
