import { afterEach, describe, expect, it, vi } from "vitest";
import { validateProviderCredential } from "../ai/provider-connections";
import { createWebhookEndpoint } from "../webhooks/service";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OUTBOUND_PRIVATE_HOST_ALLOWLIST;
});

describe("server-side outbound request boundaries", () => {
  it("rejects a private AI provider before sending its credential", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      validateProviderCredential({
        provider: "OPENAI_COMPATIBLE",
        baseUrl: "https://127.0.0.1/v1",
        apiKey: "secret-api-key",
      }),
    ).rejects.toMatchObject({
      code: "AI_PROVIDER_VALIDATION_FAILED",
      status: 400,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a private webhook before generating or storing a secret", async () => {
    await expect(
      createWebhookEndpoint(
        {
          userId: "00000000-0000-4000-8000-000000000001",
          workspaceId: "00000000-0000-4000-8000-000000000002",
          role: "ADMIN",
          email: "admin@example.com",
          displayName: "Admin",
        },
        {
          url: "https://169.254.169.254/latest/meta-data",
          enabledEvents: ["recording.ready"],
        },
      ),
    ).rejects.toMatchObject({ code: "WEBHOOK_URL_BLOCKED", status: 400 });
  });
});
