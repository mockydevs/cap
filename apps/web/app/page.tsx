import { CaptureStudio } from "../components/capture-studio";

export default function HomePage() {
  return (
    <main>
      <header className="header"><span className="brand">cap</span><span className="badge">Milestone 1 · local capture</span></header>
      <section className="hero">
        <p className="eyebrow">Browser-first screen recording</p>
        <h1>Record the work while it happens.</h1>
        <p className="lede">Capture a tab, window, or screen with optional microphone audio. Your recording remains in this browser until you download it.</p>
      </section>
      <CaptureStudio />
    </main>
  );
}
