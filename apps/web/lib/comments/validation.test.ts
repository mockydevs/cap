import { describe, expect, it } from "vitest";
import { createCommentSchema, reactionSchema } from "./validation";
describe("comments validation", () => {
  it("accepts bounded timestamped comments", () => {
    expect(
      createCommentSchema.parse({ body: "Look here", timestampMs: 12_500 })
        .timestampMs,
    ).toBe(12_500);
    expect(() =>
      createCommentSchema.parse({ body: "", timestampMs: -1 }),
    ).toThrow();
  });
  it("allows only supported reactions", () => {
    expect(reactionSchema.parse({ emoji: "👍", active: true }).active).toBe(
      true,
    );
    expect(() => reactionSchema.parse({ emoji: "🔥", active: true })).toThrow();
  });
});
