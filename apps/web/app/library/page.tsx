import { RecordingLibrary } from "../../components/recording-library";

const views = ["library", "shared", "starred", "trash"] as const;

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const requestedView = (await searchParams).view;
  const view = views.find((candidate) => candidate === requestedView) ?? "library";
  return (
    <main className="library-page">
      <RecordingLibrary key={view} initialView={view} />
    </main>
  );
}
