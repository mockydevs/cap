import { RecordingViewer } from "../../../components/recording-viewer";
export default async function RecordingPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordingId: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const query = await searchParams;
  const timestamp = Number(query.t);
  return (
    <main className="viewer-page">
      <RecordingViewer
        recordingId={(await params).recordingId}
        {...(Number.isSafeInteger(timestamp) && timestamp >= 0
          ? { initialTimestampMs: timestamp }
          : {})}
      />
    </main>
  );
}
