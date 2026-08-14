import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

export type SignedUpUser = {
  displayName: string;
  workspaceName: string;
  email: string;
  password: string;
};

/**
 * Runs the same signup flow verified field-by-field in auth.spec.ts
 * ("Display name" / "Workspace name" / "Email" / "Password" -> "Create
 * account") and waits for the redirect to the authenticated recorder page
 * ("/record").
 * A fresh signup always creates a brand-new workspace with the signer as its
 * OWNER (see apps/web/components/user-nav.tsx, which renders
 * "{displayName} · {role}"), so this also doubles as "create a workspace to
 * test against" for specs that need one.
 */
const octet = () => Math.floor(Math.random() * 256);

/**
 * A distinct caller address per signup, from the shared-CGNAT range so it can
 * never be confused with a real client.
 *
 * Sign-up and sign-in are rate limited per address (10 per 15 minutes). Every
 * page here reaches the dev server over the same loopback connection, so
 * without this the whole suite queues behind one bucket and starts failing
 * partway through a run — a throttled suite, not a tested one. Honoured only
 * because the E2E server runs with TRUSTED_PROXY_HOP_COUNT=1.
 */
async function presentAsDistinctClient(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `100.64.${octet()}.${octet()}`,
  });
}

export async function signUpAndSignIn(
  page: Page,
  label = "E2E",
): Promise<SignedUpUser> {
  await presentAsDistinctClient(page);
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const address = randomUUID().replaceAll("-", "").match(/.{4}/g)!.slice(0, 6);
  await page.setExtraHTTPHeaders({
    // Each helper call represents a separate user. Give those users distinct
    // TEST-NET IPv6 addresses so the real signup limiter does not treat the
    // entire CI runner as one client (including Playwright retries).
    "x-forwarded-for": `2001:db8:${address.join(":")}`,
  });
  const emailLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const user: SignedUpUser = {
    displayName: `${label} User ${unique}`,
    workspaceName: `${label} Workspace ${unique}`,
    email: `e2e-${emailLabel}-${unique}@example.com`,
    password: "a genuinely random password",
  };
  await page.goto("/signup");
  await page.getByLabel("Display name").fill(user.displayName);
  await page.getByLabel("Workspace name").fill(user.workspaceName);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/record$/);
  return user;
}

/**
 * Creates a real recording row via the same endpoint the capture UI uses,
 * without a real screen-share capture.
 *
 * apps/web/components/capture-studio.tsx can only start a recording through
 * `navigator.mediaDevices.getDisplayMedia`, which shows a native
 * screen-picker permission dialog that cannot be driven in this headless
 * Chromium project (there is no fake-device flag for display capture the
 * way there is for getUserMedia, and headless Chromium has no screen to
 * share regardless). Finishing an upload additionally requires PUTting
 * multipart parts straight to a real S3-compatible endpoint
 * (lib/uploads/resumable-client.ts), which this environment does not have.
 *
 * What *is* reachable without any of that: the first step of the real flow,
 * `beginResumableUpload`'s POST to /api/upload-sessions
 * (apps/web/lib/uploads/resumable-client.ts, apps/web/app/api/upload-
 * sessions/route.ts), which authorizes the request via the signed-in
 * session cookie + same-origin check (apps/web/lib/uploads/auth.ts) exactly
 * as the browser would, and inserts a `recordings` row with the real
 * default status "UPLOADING" (apps/web/db/schema.ts) before any bytes move.
 * This helper calls that same endpoint via an in-page `fetch` so the
 * request carries the real session cookie and Origin header, then stops --
 * it deliberately never completes the multipart upload. The resulting
 * recording is real and workspace-scoped, but stays at "UPLOADING" forever,
 * which is enough to exercise library/detail/comment/sharing UI that does
 * not require processed media, and nothing more.
 */
export async function createUploadingRecording(
  page: Page,
  title: string,
): Promise<string> {
  return page.evaluate(async (recordingTitle) => {
    const response = await fetch("/api/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: recordingTitle,
        contentType: "video/webm",
        sizeBytes: 2048,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Could not create upload session (${response.status}): ${await response.text()}`,
      );
    }
    const payload = (await response.json()) as { recordingId: string };
    return payload.recordingId;
  }, title);
}
