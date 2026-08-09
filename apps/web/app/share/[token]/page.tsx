import { SharedRecording } from "../../../components/shared-recording";
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  return <SharedRecording token={(await params).token} />;
}
