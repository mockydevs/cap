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
        <UserNav />
      </header>
      <div className="record-workspace">
        <CaptureStudio />
      </div>
    </main>
  );
}
