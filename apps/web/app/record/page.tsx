import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CaptureStudio } from "../../components/capture-studio";
import { UserNav } from "../../components/user-nav";
import { actorFromToken, sessionCookieName } from "../../lib/auth/session";

export const metadata: Metadata = {
  title: "New recording — Cap",
};

export default async function RecordPage() {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const actor = await actorFromToken(token);
  if (!actor) redirect("/login");

  return (
    <main className="record-shell">
      <header className="header">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true" />
          cap
        </Link>
        <span className="badge">Private workspace</span>
        <UserNav />
      </header>
      <section className="record-hero">
        <div className="record-hero-copy">
          <p className="eyebrow">New recording</p>
          <h1>What do you want to show?</h1>
          <p className="lede">
            Choose your screen, add your voice or camera, and Cap will take care
            of the upload and processing.
          </p>
        </div>
        <div className="record-promise" aria-label="How recording works">
          <div>
            <span>01</span>
            <p>
              <strong>Choose a source</strong>
              <small>A tab, window, or your entire screen</small>
            </p>
          </div>
          <div>
            <span>02</span>
            <p>
              <strong>Record privately</strong>
              <small>Capture stays local until you upload</small>
            </p>
          </div>
          <div>
            <span>03</span>
            <p>
              <strong>Share when ready</strong>
              <small>Processing starts after a secure upload</small>
            </p>
          </div>
        </div>
      </section>
      <CaptureStudio />
    </main>
  );
}
