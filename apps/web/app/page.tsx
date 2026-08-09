import { CaptureStudio } from "../components/capture-studio";
import { UserNav } from "../components/user-nav";

export default function HomePage() {
  return (
    <main>
      <header className="header">
        <span className="brand">cap</span>
        <span className="badge">Browser capture</span>
        <UserNav />
      </header>
      <section className="hero">
        <p className="eyebrow">Browser-first screen recording</p>
        <h1>Record the work while it happens.</h1>
        <p className="lede">
          Capture a tab, window, or screen with optional microphone audio, then
          upload it directly to private AWS storage for processing.
        </p>
      </section>
      <CaptureStudio />
    </main>
  );
}
