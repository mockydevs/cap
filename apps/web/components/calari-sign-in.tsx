import Link from "next/link";
import { WorkspaceMark } from "./workspace-mark";

export function CalariSignIn() {
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <WorkspaceMark href="/" />
        <p className="eyebrow">Your existing Calari account</p>
        <h1>Sign in to Calari.</h1>
        <p>
          Calari handles your access. You do not need a separate Cap account or
          password.
        </p>
        <a className="marketing-primary" href="/portal">
          Sign in to Calari
        </a>
        <p>
          <Link href="/">Back to downloads</Link>
        </p>
      </section>
    </main>
  );
}
