import { RecordingViewer } from "../../../components/recording-viewer";
export default async function RecordingPage({
  params,
}: {
  params: Promise<{ recordingId: string }>;
}) {
  return (
    <main>
      <RecordingViewer recordingId={(await params).recordingId} />
    </main>
  );
}
