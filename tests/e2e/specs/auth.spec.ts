import { expect, test } from "@playwright/test";

test("shows the login form with expected fields", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in." })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create an account" }),
  ).toBeVisible();
});

test("shows an error message after a failed login", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(`nonexistent-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login\?error=credentials/);
  await expect(page.getByRole("alert")).toContainText("incorrect");
});

test("redirects an unauthenticated visitor away from the library", async ({
  page,
}) => {
  await page.goto("/library");
  await expect(page).toHaveURL(/\/login$/);
});

test("requires an account before opening the recorder", async ({ page }) => {
  await page.goto("/record");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Start capture" })).toHaveCount(
    0,
  );
});

test("signs up, reaches an authenticated session, and can sign out", async ({
  page,
}) => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.goto("/signup");
  await page.getByLabel("Display name").fill("E2E Test User");
  await page.getByLabel("Workspace name").fill("E2E Test Workspace");
  await page.getByLabel("Email").fill(`e2e-${unique}@example.com`);
  await page.getByLabel("Password").fill("a genuinely random password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/record$/);
  const account = page.locator(".account-pill");
  await expect(
    account.getByText("E2E Test User", { exact: true }),
  ).toBeVisible();
  await expect(account.getByText("owner", { exact: true })).toBeVisible();

  await page.goto("/library");
  await expect(page).toHaveURL(/\/library/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});
