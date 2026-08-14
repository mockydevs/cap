import { expect, test } from "@playwright/test";
import { createUploadingRecording, signUpAndSignIn } from "./helpers";

// apps/web/components/comment-thread.tsx, rendered from recording-viewer.tsx.
// CommentThread (and its API route, apps/web/app/api/recordings/[recordingId]
// /comments/route.ts) does not require the recording to have finished
// processing, so this exercises the real create-and-list round trip against
// a recording that only ever reaches "UPLOADING" (see helpers.ts).

test("adds a timestamped comment to a recording you own", async ({ page }) => {
  const user = await signUpAndSignIn(page, "Comments");
  const recordingId = await createUploadingRecording(
    page,
    `Comment spec recording ${Date.now()}`,
  );
  await page.goto(`/library/${recordingId}`);

  // The inspector is a tablist that opens on Transcript.
  await page.getByRole("tab", { name: "Comments" }).click();

  const commentBody = `A note left during review ${Date.now()}`;
  await page.getByLabel("Comment", { exact: true }).fill(commentBody);
  // The submit button's label encodes the current playback position; with no
  // video loaded yet timestampMs stays 0, so it reads "Comment at 00:00".
  await page.getByRole("button", { name: "Comment at 00:00" }).click();

  await expect(page.getByText(commentBody)).toBeVisible();
  await expect(page.getByText(user.displayName)).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
});
