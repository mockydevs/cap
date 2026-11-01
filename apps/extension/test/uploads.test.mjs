import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptableGaps, classifyUpload } from "../src/shared.js";

test("only a confirmed upload is an acknowledgement", () => {
  assert.equal(classifyUpload(201, {}), "ack");
  assert.equal(classifyUpload(200, { status: "duplicate" }), "ack");
  assert.equal(classifyUpload(401, {}), "reauth");
  assert.equal(classifyUpload(404, { error: "meeting_not_found" }), "reauth");
  for (const s of [408, 429, 500, 503])
    assert.equal(classifyUpload(s, {}), "retry");
  for (const s of [400, 409, 413, 415])
    assert.equal(classifyUpload(s, { error: "x" }), "quarantine");
});

test("gaps are accepted only for audio that is gone or quarantined", () => {
  assert.equal(acceptableGaps([1], []), true);
  assert.equal(acceptableGaps([1], [{ seq: 1, quarantined: true }]), true);
  assert.equal(acceptableGaps([1, 2], [{ seq: 2 }]), false);
});
