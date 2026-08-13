import { expect, test } from "@playwright/test";
import { signUpAndSignIn } from "./helpers";

// apps/web/components/admin-panel.tsx, apps/web/app/admin/page.tsx.
// A fresh signup is always the OWNER of a brand-new workspace (see
// helpers.ts / apps/web/components/user-nav.tsx), which satisfies every
// route this panel calls (all require at least the ADMIN role), so the full
// panel renders without any additional setup.

test("shows a fresh workspace owner the full admin panel", async ({ page }) => {
  const user = await signUpAndSignIn(page, "Admin Owner");
  await page.goto("/admin");

  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(page.getByText(user.email, { exact: false })).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Invite a member" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Retention policy" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Webhooks" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "AI providers" }),
  ).toBeVisible();
  // The summary comes from apps/web/components/ai-settings.tsx, so this fails
  // if the AI panel is ever detached from the admin page again.
  await expect(page.getByText("Workspace AI policy")).toBeVisible();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
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

  await page
    .getByLabel("Auto-delete recordings after (days, blank = keep forever)")
    .fill("90");
  await page.getByRole("button", { name: "Save retention policy" }).click();
  await expect(page.getByText("Retention policy saved.")).toBeVisible();
});
