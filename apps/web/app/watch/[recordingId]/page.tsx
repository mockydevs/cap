import { SharedRecording } from "../../../components/shared-recording";
export default async function WatchPage({
  params,
}: {
  params: Promise<{ recordingId: string }>;
}) {
  return <SharedRecording recordingId={(await params).recordingId} />;
}
