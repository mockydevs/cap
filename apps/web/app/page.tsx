import type { Metadata } from "next";
import Link from "next/link";
import { UserNav } from "../components/user-nav";

export const metadata: Metadata = {
  title: "Cap — explain work with video",
  description:
    "Record your screen, share the context, and keep work moving with searchable transcripts, comments, and AI-powered summaries.",
};

const features = [
  {
    number: "01",
    title: "Capture the whole explanation",
    body: "Record a browser tab, window, or full screen with microphone and camera. Cap keeps the source safe while your video is processed.",
    icon: "capture",
  },
  {
    number: "02",
    title: "Turn video into useful context",
    body: "Automatic transcripts, captions, search, and AI outputs make every walkthrough easier to scan, reuse, and act on.",
    icon: "transcript",
  },
  {
    number: "03",
    title: "Share without another meeting",
    body: "Send a secure link, collect timestamped comments, control access, and keep feedback attached to the moment it belongs to.",
    icon: "share",
  },
];

const useCases = [
  [
    "Engineering",
    "Reproduce bugs with the screen, voice, and timeline in one place.",
  ],
  [
    "Product",
    "Walk through decisions and keep roadmap context available on demand.",
  ],
  [
    "Design",
    "Present work, gather precise feedback, and reduce review meetings.",
  ],
  ["Support", "Show the fix clearly and build a reusable answer library."],
];

function ProductIcon({ name }: { name: string }) {
  if (name === "transcript")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" />
      </svg>
    );
  if (name === "share")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="12" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="m8.2 10.9 7.5-3.8M8.2 13.1l7.5 3.8" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <main className="marketing-shell">
      <header className="marketing-header">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          cap
        </Link>
        <nav className="marketing-nav" aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#features">Features</a>
          <a href="#use-cases">Use cases</a>
          <a href="#security">Security</a>
        </nav>
        <UserNav />
      </header>

      <section className="marketing-hero">
        <div className="marketing-hero-copy">
          <p className="eyebrow">Async video for work that moves</p>
          <h1>Say it once. Show it clearly.</h1>
          <p className="marketing-lede">
            Cap is a browser-first screen recorder that turns walkthroughs into
            clear, searchable, shareable context for your team.
          </p>
          <div className="marketing-actions">
            <Link className="marketing-primary" href="/signup">
              Start recording free
              <span aria-hidden="true">→</span>
            </Link>
            <a className="marketing-secondary" href="#how-it-works">
              See how Cap works
            </a>
          </div>
          <p className="marketing-note">
            An account is required to record. Your workspace stays private by
            default.
          </p>
        </div>

        <div
          className="product-demo"
          aria-label="Preview of the Cap recording workspace"
        >
          <div className="product-demo-bar">
            <span className="product-demo-brand">
              <span className="brand-mark" />
              cap
            </span>
            <span>Q3 roadmap walkthrough</span>
            <span className="product-demo-live">REC 04:12</span>
          </div>
          <div className="product-demo-body">
            <div className="product-demo-video">
              <div className="demo-window">
                <span>Product roadmap</span>
                <strong>Three bets for the next quarter.</strong>
                <div className="demo-bars">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <div className="demo-presenter">
                <span>JL</span>
              </div>
              <div className="demo-controls">
                <span>▶</span>
                <i />
                <span>04:12</span>
                <span>CC</span>
              </div>
            </div>
            <aside className="product-demo-transcript">
              <div>
                <strong>Transcript</strong>
                <span>EN</span>
              </div>
              <p>
                <time>00:04</time> The three bets for next quarter are
                onboarding, the editor, and webhooks.
              </p>
              <p className="active">
                <time>00:18</time> I&apos;ll walk through what changes for
                customers and why.
              </p>
              <p>
                <time>00:31</time> First, we are making the new workspace flow
                much faster.
              </p>
            </aside>
          </div>
        </div>
      </section>

      <section className="capabilities-strip" aria-label="Core capabilities">
        <span>Screen + camera</span>
        <span>Private storage</span>
        <span>Searchable transcript</span>
        <span>Secure sharing</span>
        <span>Timeline editor</span>
      </section>

      <section className="marketing-intro" id="how-it-works">
        <div>
          <p className="eyebrow">How Cap works</p>
          <h2>From idea to shared context in three steps.</h2>
        </div>
        <p>
          Replace long messages and unnecessary meetings with a recording people
          can watch, search, comment on, and revisit when they need it.
        </p>
      </section>

      <section className="workflow-grid">
        {features.map((feature) => (
          <article className="workflow-card" key={feature.number}>
            <div className="workflow-card-top">
              <span>{feature.number}</span>
              <ProductIcon name={feature.icon} />
            </div>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </article>
        ))}
      </section>

      <section className="feature-showcase" id="features">
        <div className="feature-showcase-copy">
          <p className="eyebrow">More than a recorder</p>
          <h2>Every recording stays useful after you stop talking.</h2>
          <p>
            Cap keeps the video, transcript, decisions, and feedback together—so
            the explanation becomes durable team knowledge.
          </p>
          <Link className="marketing-secondary" href="/signup">
            Create your workspace →
          </Link>
        </div>
        <div className="feature-stack">
          <article>
            <span>01 / Understand</span>
            <h3>Transcripts and captions</h3>
            <p>
              Read, search, edit, export, or jump directly to the right moment.
            </p>
          </article>
          <article>
            <span>02 / Refine</span>
            <h3>Non-destructive editing</h3>
            <p>
              Trim, split, reorder, and publish without touching the source
              recording.
            </p>
          </article>
          <article>
            <span>03 / Collaborate</span>
            <h3>Comments and AI assistance</h3>
            <p>
              Collect timestamped feedback and generate useful summaries and
              answers.
            </p>
          </article>
        </div>
      </section>

      <section className="use-cases" id="use-cases">
        <div className="section-heading">
          <p className="eyebrow">Built for real work</p>
          <h2>Show the context your words leave out.</h2>
        </div>
        <div className="use-case-grid">
          {useCases.map(([title, body], index) => (
            <article key={title}>
              <span>0{index + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="security-band" id="security">
        <div>
          <p className="eyebrow">Private by default</p>
          <h2>Your team&apos;s context stays under control.</h2>
        </div>
        <div className="security-points">
          <span>Authenticated workspaces</span>
          <span>Private object storage</span>
          <span>Password-protected sharing</span>
          <span>Configurable retention</span>
        </div>
      </section>

      <section className="marketing-cta">
        <p className="eyebrow">Less explaining twice</p>
        <h2>Record it. Share it. Keep moving.</h2>
        <p>Create a private workspace and make your first recording.</p>
        <Link className="marketing-primary" href="/signup">
          Create your account <span aria-hidden="true">→</span>
        </Link>
      </section>

      <footer className="marketing-footer">
        <Link className="brand" href="/">
          <span className="brand-mark" />
          cap
        </Link>
        <p>Browser-first screen recording for clear, asynchronous work.</p>
        <div>
          <Link href="/login">Sign in</Link>
          <Link href="/signup">Create account</Link>
        </div>
      </footer>
    </main>
  );
}
