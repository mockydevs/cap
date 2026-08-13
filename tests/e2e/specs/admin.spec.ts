import { expect, test } from "@playwright/test";
import { signUpAndSignIn } from "./helpers";

// apps/web/components/admin-panel.tsx, apps/web/app/admin/page.tsx.
// A fresh signup is always the OWNER of a brand-new workspace (see
// helpers.ts / apps/web/components/user-nav.tsx), which satisfies every
// route this panel calls (all require at least the ADMIN role), so the full
// panel renders without any additional setup.

// Settings is a tabbed surface: one panel at a time, so each section is
// reached by its tab rather than by scrolling one long page.
test("gives a fresh workspace owner every settings section", async ({
  page,
}) => {
  const user = await signUpAndSignIn(page, "Admin Owner");
  await page.goto("/admin");

  // Members is the landing tab.
  await expect(page.getByText(user.email, { exact: false })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Invite a member" }),
  ).toBeVisible();

  for (const [tab, heading] of [
    ["Retention", "Retention policy"],
    ["Integrations", "Webhooks"],
    ["AI", "AI providers"],
    ["Security", "API keys"],
  ] as const) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }

  // Security holds two sections; the second must come with it.
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  // Fails if the AI panel is ever detached from the admin page again.
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await expect(page.getByText("Workspace policy")).toBeVisible();
});

test("invites a new member and saves the retention policy", async ({
  page,
}) => {
  await signUpAndSignIn(page, "Admin Actions");
  await page.goto("/admin");

  const inviteEmail = `invitee-${Date.now()}@example.com`;
  await page.getByLabel("Email").fill(inviteEmail);
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(
    page.getByText(`${inviteEmail} has no account yet.`, { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Pending invitations" }),
  ).toBeVisible();

  // Retention lives on its own tab now.
  await page.getByRole("button", { name: "Retention", exact: true }).click();
  await page
    .getByLabel("Auto-delete recordings after (days, blank = keep forever)")
    .fill("90");
  await page.getByRole("button", { name: "Save retention policy" }).click();
  await expect(page.getByText("Retention policy saved.")).toBeVisible();
});

// apps/web/components/ai-settings.tsx and billing-settings.tsx. A fresh
// workspace has no provider connection and no plan, which is exactly the state
// that used to surface as a raw error code the first time a member clicked an
// AI action. These assertions pin the panel that now explains it up front.
test("tells a fresh workspace who pays for each AI feature", async ({
  page,
}) => {
  await signUpAndSignIn(page, "AI Entitlements");
  await page.goto("/admin");
  await page.getByRole("button", { name: "AI", exact: true }).click();

  await expect(
    page.getByRole("heading", { name: "Who pays for AI" }),
  ).toBeVisible();
  for (const feature of ["Transcripts", "Analysis", "Semantic search"])
    await expect(page.getByText(feature, { exact: true })).toBeVisible();
  // Nothing can pay yet, and the panel must say so rather than look ready.
  await expect(
    page.getByText("Unavailable", { exact: false }).first(),
  ).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Cap AI plan" }),
  ).toBeVisible();
  // With AI_PLANS unset the deployment sells nothing, and the card says so
  // instead of rendering an empty plan list.
  await expect(
    page.getByText("does not sell AI plans", { exact: false }),
  ).toBeVisible();
});
