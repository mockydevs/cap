import { describe, expect, it } from "vitest";
import { parseModelIds } from "./provider-connections";

describe("parseModelIds", () => {
  it("extracts sorted string ids from an OpenAI-compatible models payload", () => {
    expect(
      parseModelIds({
        data: [{ id: "gpt-5-mini" }, { id: "gpt-5" }, { id: "gpt-4o" }],
      }),
    ).toEqual(["gpt-4o", "gpt-5", "gpt-5-mini"]);
  });

  it("ignores entries without a string id", () => {
    expect(
      parseModelIds({
        data: [{ id: "claude-sonnet-4-5" }, { id: 42 }, { notId: "x" }, null],
      }),
    ).toEqual(["claude-sonnet-4-5"]);
  });

  it("returns an empty list when the payload has no data array", () => {
    expect(parseModelIds({})).toEqual([]);
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds({ data: "not-an-array" })).toEqual([]);
  });
});
