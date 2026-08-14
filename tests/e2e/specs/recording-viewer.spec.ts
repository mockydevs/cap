import { expect, test } from "@playwright/test";
import { createUploadingRecording, signUpAndSignIn } from "./helpers";

// apps/web/components/recording-viewer.tsx, apps/web/app/library/[recordingId]/page.tsx
//
// The recording created below never leaves "UPLOADING" (see helpers.ts), so
// this only verifies the panels the viewer renders before processing
// finishes: it does not exercise real playback, transcript, or AI-generated
// content, all of which need the FFmpeg/transcription/AI workers running
// against a real recording -- not available in this environment.

test("shows an owner their own recording's pre-processing panels", async ({
  page,
}) => {
  await signUpAndSignIn(page, "Viewer Owner");
  const title = `Viewer spec recording ${Date.now()}`;
  const recordingId = await createUploadingRecording(page, title);

  await page.goto(`/library/${recordingId}`);

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("UPLOADING", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Preparing playback…" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit recording" })).toHaveCount(
    0,
  );

  // TranscriptPanel: no transcript exists yet for this recording.
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeVisible();
  await expect(
    page.getByText(
      "A transcript will appear here when transcription is complete.",
    ),
  ).toBeVisible();

  // AiPanel: renders its capability actions regardless of processing status.
  await expect(
    page.getByRole("heading", { name: "Recording intelligence" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "chapters" })).toBeVisible();
  await expect(page.getByRole("button", { name: "summary" })).toBeVisible();

  // CommentThread: available regardless of processing status.
  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
  await expect(page.getByLabel("Comment", { exact: true })).toBeVisible();

  // ShareControls: rendered for the owner (canManageSharing).
  await expect(
    page.getByRole("heading", { name: "Share recording" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save access" })).toBeVisible();
});

test("enforces private access across workspaces", async ({ page, browser }) => {
  await signUpAndSignIn(page, "Viewer Private Owner");
  const recordingId = await createUploadingRecording(
    page,
    `Private spec recording ${Date.now()}`,
  );

  const outsiderContext = await browser.newContext();
  const outsiderPage = await outsiderContext.newPage();
  try {
    await signUpAndSignIn(outsiderPage, "Viewer Outsider");
    await outsiderPage.goto(`/library/${recordingId}`);
    await expect(
      outsiderPage.getByText("Recording not found in this workspace."),
    ).toBeVisible();
    await expect(
      outsiderPage.getByRole("link", { name: "← Library" }),
    ).toBeVisible();
  } finally {
    await outsiderContext.close();
  }
});
