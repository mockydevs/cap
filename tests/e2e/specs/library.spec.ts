import { expect, test } from "@playwright/test";
import { createUploadingRecording, signUpAndSignIn } from "./helpers";

// apps/web/components/recording-library.tsx

test("shows the empty state for a freshly created workspace", async ({
  page,
}) => {
  await signUpAndSignIn(page, "Library Empty");
  await page.goto("/library");
  await expect(page.getByRole("heading", { name: "Recordings" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No recordings yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Start recording" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "New recording" })).toBeVisible();
});

test("lists a recording created through the upload API", async ({ page }) => {
  await signUpAndSignIn(page, "Library List");
  const title = `Library spec recording ${Date.now()}`;
  await createUploadingRecording(page, title);

  // A fresh navigation re-triggers RecordingLibrary's load() on mount.
  await page.goto("/library");

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("UPLOADING", { exact: true })).toBeVisible();
});
