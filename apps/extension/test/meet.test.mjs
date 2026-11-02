import { test } from "node:test";
import assert from "node:assert/strict";

// A minimal Meet page: its visible text and buttons change as calls start and end.
let onMutation;
const page = { text: "", buttons: [] };
const sent = [];
globalThis.MutationObserver = class {
  constructor(fn) {
    onMutation = fn;
  }
  observe() {}
};
globalThis.document = {
  documentElement: {},
  get body() {
    return { innerText: page.text };
  },
  querySelectorAll: () => page.buttons.map((innerText) => ({ innerText })),
  getElementById: () => null,
};
globalThis.chrome = {
  runtime: {
    sendMessage: async (msg) => {
      sent.push(msg.type);
    },
    onMessage: { addListener() {} },
  },
};
await import("../src/meet.js");
const show = (text, buttons = []) => {
  page.text = text;
  page.buttons = buttons;
  onMutation();
};
const ended = () => sent.filter((t) => t === "meet-ended").length;

test("each call's end is reported once, including after rejoining the same page", () => {
  show("Meeting in progress", ["Leave call"]);
  assert.equal(ended(), 0);

  show("You left the meeting", ["Rejoin", "Return to home screen"]);
  assert.equal(ended(), 1, "first call ended");
  show("You left the meeting", ["Rejoin", "Return to home screen"]);
  show("You left the meeting. How was the audio?", ["Rejoin"]);
  assert.equal(ended(), 1, "the same ended screen is reported only once");

  show("Meeting in progress", ["Leave call"]); // rejoined, new recording possible
  assert.equal(ended(), 1);
  show("The call has ended");
  assert.equal(ended(), 2, "the second call's end is reported too");

  show("Meeting in progress", ["Leave call"]);
  show("Back in the lobby", ["Rejoin"]); // only a Rejoin button
  assert.equal(ended(), 3);
});
