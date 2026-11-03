import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const script = readFileSync(
  new URL("../src/web/app.js", import.meta.url),
  "utf8",
);

function page(scope, storage, savedDraft) {
  const field = {
    dataset: { draft: "meeting.new" },
    value: "",
    defaultValue: "",
    tagName: "TEXTAREA",
    closest: () => null,
    addEventListener() {},
  };
  const document = {
    body: { dataset: { draftScope: scope, savedDraft } },
    querySelectorAll: (selector) =>
      selector === "[data-draft]" ? [field] : [],
    getElementById: () => null,
  };
  vm.runInNewContext(script, {
    document,
    sessionStorage: storage,
    window: { addEventListener() {} },
  });
  return field.value;
}

function storage(values) {
  return Object.defineProperties(
    { ...values },
    {
      getItem: {
        value(key) {
          return this[key] ?? null;
        },
      },
      setItem: {
        value(key, value) {
          this[key] = value;
        },
      },
      removeItem: {
        value(key) {
          delete this[key];
        },
      },
    },
  );
}

test("expiry and another user signing in never restores the previous draft", () => {
  const kept = storage({
    "cap.draft.user-a-session.meeting.new": "Private unsaved client notes",
    "cap.draft.meeting.new": "Legacy private draft",
    unrelated: "keep",
  });
  assert.equal(page("user-b-session", kept), "");
  assert.deepEqual(Object.keys(kept), ["unrelated"]);
});

test("same-session reload restores a draft and successful save clears it", () => {
  const kept = storage({ "cap.draft.current-session.meeting.new": "My draft" });
  assert.equal(page("current-session", kept), "My draft");
  assert.equal(page("current-session", kept, "meeting.new"), "");
  assert.equal(kept.getItem("cap.draft.current-session.meeting.new"), null);
});

test("signed-out pages clear session drafts without restoring them", () => {
  const kept = storage({ "cap.draft.old-session.meeting.new": "Private" });
  assert.equal(page(undefined, kept), "");
  assert.deepEqual(Object.keys(kept), []);
});
