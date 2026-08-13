import { describe, expect, it } from "vitest";
import { call, signIn } from "./http";

/**
 * Every route here is driven end to end: real handler, real session cookie,
 * real database. The AI policy round trip is the reason this file exists — it
 * shipped broken because the read returned a shape the write rejected, and no
 * test exercised both halves together.
 */

const aiPolicy = await import("../../app/api/ai/policy/route");
const aiEntitlement = await import("../../app/api/ai/entitlement/route");
const aiProviders = await import("../../app/api/ai/providers/route");
const aiUsage = await import("../../app/api/ai/usage/route");
const billing = await import("../../app/api/billing/route");
const billingCheckout = await import("../../app/api/billing/checkout/route");

describe("AI policy round trip", () => {
  it("accepts back exactly what it handed out, once a row exists", async () => {
    const session = await signIn("OWNER");

    // Before any save the read is a synthesised default; the shape that
    // actually broke is the one read back out of the table, so the row has to
    // exist first. This is the reload-and-save-again path a user takes.
    const created = await call(aiPolicy.PUT, {
      method: "PUT",
      session,
      body: {
        enabled: true,
        allowedProvider: "openai-compatible",
        allowExternalProcessing: true,
        monthlyTokenLimit: 1_000_000,
        monthlyCostLimitMicrounits: 25_000_000,
      },
    });
    expect(created.status).toBe(200);

    const read = await call(aiPolicy.GET, { session });
    expect(read.status).toBe(200);

    // Precisely what the settings form does: post back the object it received.
    const write = await call(aiPolicy.PUT, {
      method: "PUT",
      session,
      body: { ...read.body, monthlyTokenLimit: 750_000 },
    });
    expect(write.status).toBe(200);

    const reread = await call(aiPolicy.GET, { session });
    expect(reread.body.enabled).toBe(true);
    expect(reread.body.monthlyTokenLimit).toBe(750_000);
  });

  it("keeps the write response postable too, so a caller may feed it back", async () => {
    const session = await signIn("OWNER");
    const first = await call(aiPolicy.PUT, {
      method: "PUT",
      session,
      body: {
        enabled: true,
        allowedProvider: "openai-compatible",
        allowExternalProcessing: true,
        monthlyTokenLimit: 500_000,
        monthlyCostLimitMicrounits: 10_000_000,
      },
    });
    expect(first.status).toBe(200);
    const echoed = await call(aiPolicy.PUT, {
      method: "PUT",
      session,
      body: first.body,
    });
    expect(echoed.status).toBe(200);
  });

  it("refuses a member without the admin role", async () => {
    const session = await signIn("MEMBER");
    const response = await call(aiPolicy.PUT, {
      method: "PUT",
      session,
      body: {
        enabled: true,
        allowedProvider: "openai-compatible",
        allowExternalProcessing: true,
        monthlyTokenLimit: 1_000,
        monthlyCostLimitMicrounits: 1_000,
      },
    });
    expect(response.status).toBe(403);
  });

  it("refuses a request with no session", async () => {
    expect((await call(aiPolicy.GET)).status).toBe(401);
  });
});

describe("AI entitlement", () => {
  it("reports every purpose as unavailable for a workspace with nothing configured", async () => {
    const session = await signIn("OWNER");
    const response = await call(aiEntitlement.GET, { session });
    expect(response.status).toBe(200);
    for (const purpose of ["analysis", "embeddings", "transcription"])
      expect(response.body[purpose]).toEqual({
        lane: "NONE",
        reason: "AI_DISABLED",
      });
  });

  it("moves from disabled to unconfigured once the policy is switched on", async () => {
    const session = await signIn("OWNER");
    await call(aiPolicy.PUT, {
      method: "PUT",
      session,
      body: {
        enabled: true,
        allowedProvider: "openai-compatible",
        allowExternalProcessing: true,
        monthlyTokenLimit: 1_000_000,
        monthlyCostLimitMicrounits: 25_000_000,
      },
    });
    const response = await call(aiEntitlement.GET, { session });
    expect(response.body.analysis).toEqual({
      lane: "NONE",
      reason: "AI_PROVIDER_NOT_CONFIGURED",
    });
  });
});

describe("AI usage", () => {
  it("starts a workspace at zero across tokens, audio and cost", async () => {
    const session = await signIn("OWNER");
    const response = await call(aiUsage.GET, { session });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      tokens: 0,
      audioMs: 0,
      costMicrounits: 0,
    });
  });
});

describe("AI provider connections", () => {
  it("lists nothing for a new workspace, and refuses non-admins", async () => {
    const owner = await signIn("OWNER");
    const listed = await call(aiProviders.GET, { session: owner });
    expect(listed.status).toBe(200);
    expect(listed.body.connections).toEqual([]);
    expect(listed.body.routes).toEqual([]);

    const member = await signIn("MEMBER");
    expect((await call(aiProviders.GET, { session: member })).status).toBe(403);
  });

  it("rejects a cross-origin write before it reaches validation", async () => {
    const session = await signIn("OWNER");
    const response = await aiProviders.POST(
      new Request("http://localhost:3000/api/ai/providers", {
        method: "POST",
        headers: {
          origin: "https://evil.example.com",
          cookie: session.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("INVALID_ORIGIN");
  });
});

describe("Billing", () => {
  it("reports no plans when the deployment sells none", async () => {
    const session = await signIn("OWNER");
    const response = await call(billing.GET, { session });
    expect(response.status).toBe(200);
    expect(response.body.available).toBe(false);
    expect(response.body.plans).toEqual([]);
    expect(response.body.subscription).toBeNull();
  });

  it("refuses checkout when billing is not configured, rather than failing obscurely", async () => {
    const session = await signIn("OWNER");
    const response = await call(billingCheckout.POST, {
      method: "POST",
      session,
      body: { planCode: "starter" },
    });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("BILLING_NOT_CONFIGURED");
  });
});
