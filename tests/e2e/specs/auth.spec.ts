import { expect, test } from "@playwright/test";
import { seedLegacySession } from "./helpers";

const closed = [
  "/api/auth/signup",
  "/api/auth/login",
  "/api/auth/google",
  "/api/auth/google/callback",
  "/api/desktop/auth/login",
  "/api/desktop/auth/google",
  "/api/desktop/auth/google/config",
];

test("offers only Calari sign-in, with no Cap password or account creation", async ({
  page,
}) => {
  await page.goto("/signup");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Sign in to Calari." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign in to Calari", exact: true }),
  ).toHaveAttribute("href", "/portal");
  await expect(
    page.locator("input[type=password], form[action='/api/auth/signup']"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /create.*account/i }),
  ).toHaveCount(0);
});

test("server rejects every retired password/signup/Google provisioning endpoint", async ({
  request,
}) => {
  for (const path of closed) {
    for (const method of ["GET", "POST"]) {
      const response = await request.fetch(path, {
        method,
        data:
          method === "POST"
            ? { email: "blocked@example.com", password: "not-a-real-password" }
            : undefined,
      });
      expect(response.status(), `${method} ${path}`).toBe(410);
      expect(await response.json()).toMatchObject({
        error: { code: "CALARI_SIGN_IN_REQUIRED" },
        signInUrl: "/portal",
      });
      expect(response.headers()["set-cookie"]).toBeUndefined();
    }
  }
});

test("unauthenticated legacy data pages retain their access checks", async ({
  page,
}) => {
  for (const path of ["/library", "/record"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("heading", { name: "Sign in to Calari." }),
    ).toBeVisible();
  }
});

test("existing legacy sessions, data and logout remain usable", async ({
  page,
}) => {
  const user = await seedLegacySession(page, "Legacy session");
  await page.goto("/library");
  await expect(page).toHaveURL(/\/library/);
  await page.locator(".account-menu summary").click();
  await expect(
    page
      .locator(".account-identity")
      .getByText(user.displayName, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("heading", { name: "Sign in to Calari." }),
  ).toBeVisible();
});
