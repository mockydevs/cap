import { afterEach, describe, expect, it, vi } from "vitest";
import { hasTrustedOrigin, publicAppUrl } from "./origin";

describe("auth origin", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds redirects from the configured public origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://cap.example.com/base");

    expect(publicAppUrl("/library").href).toBe(
      "https://cap.example.com/library",
    );
  });

  it("does not trust the reverse proxy's internal request URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://cap.example.com");
    const request = new Request("https://0.0.0.0:3000/api/auth/login", {
      headers: { origin: "https://cap.example.com" },
    });

    expect(hasTrustedOrigin(request)).toBe(true);
    expect(publicAppUrl("/library").origin).toBe("https://cap.example.com");
  });

  it("requires the public application URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    expect(() => publicAppUrl("/library")).toThrow(
      "NEXT_PUBLIC_APP_URL is required",
    );
  });
});
