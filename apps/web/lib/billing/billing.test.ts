import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiPlans,
  BillingConfigurationError,
  managedMarkupPercent,
  planByCode,
  planByPriceId,
} from "./plans";
import { normalizeSubscription, verifyWebhookSignature } from "./stripe";

const ORIGINAL = {
  plans: process.env.AI_PLANS,
  markup: process.env.AI_MANAGED_MARKUP_PERCENT,
};

afterEach(() => {
  if (ORIGINAL.plans === undefined) delete process.env.AI_PLANS;
  else process.env.AI_PLANS = ORIGINAL.plans;
  if (ORIGINAL.markup === undefined)
    delete process.env.AI_MANAGED_MARKUP_PERCENT;
  else process.env.AI_MANAGED_MARKUP_PERCENT = ORIGINAL.markup;
});

const STARTER = {
  code: "starter",
  label: "Starter",
  priceId: "price_123",
  includedCreditMicrounits: 5_000_000,
};

describe("plan catalogue", () => {
  it("sells nothing when AI_PLANS is unset, so bring-your-own-key stays the only lane", () => {
    delete process.env.AI_PLANS;
    expect(aiPlans()).toEqual([]);
  });

  it("parses a configured catalogue and looks plans up by code and price", () => {
    process.env.AI_PLANS = JSON.stringify([STARTER]);
    expect(aiPlans()).toEqual([STARTER]);
    expect(planByCode("starter")).toEqual(STARTER);
    expect(planByPriceId("price_123")).toEqual(STARTER);
    expect(planByPriceId("price_retired")).toBeUndefined();
  });

  it("rejects a catalogue with duplicate codes or prices", () => {
    process.env.AI_PLANS = JSON.stringify([
      STARTER,
      { ...STARTER, label: "B" },
    ]);
    expect(() => aiPlans()).toThrow(BillingConfigurationError);
  });

  it("rejects malformed JSON rather than silently selling nothing", () => {
    process.env.AI_PLANS = "{not json";
    expect(() => aiPlans()).toThrow(BillingConfigurationError);
  });

  it("raises a distinct error for an unknown plan code", () => {
    process.env.AI_PLANS = JSON.stringify([STARTER]);
    expect(() => planByCode("enterprise")).toThrow(
      expect.objectContaining({ code: "BILLING_PLAN_NOT_FOUND" }),
    );
  });

  it("resells at cost when the markup is unset or nonsensical", () => {
    delete process.env.AI_MANAGED_MARKUP_PERCENT;
    expect(managedMarkupPercent()).toBe(0);
    process.env.AI_MANAGED_MARKUP_PERCENT = "-5";
    expect(managedMarkupPercent()).toBe(0);
    process.env.AI_MANAGED_MARKUP_PERCENT = "30";
    expect(managedMarkupPercent()).toBe(30);
  });
});

describe("webhook signature", () => {
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_1", type: "ping" });
  const now = new Date("2026-08-13T12:00:00.000Z");
  const sign = (timestamp: number, body = payload, key = secret) =>
    createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex");

  it("accepts a signature over the exact bytes received", () => {
    const timestamp = Math.floor(now.getTime() / 1000);
    expect(
      verifyWebhookSignature({
        payload,
        header: `t=${timestamp},v1=${sign(timestamp)}`,
        secret,
        now,
      }),
    ).toBe(true);
  });

  it("accepts when any one of several offered signatures matches, for secret rotation", () => {
    const timestamp = Math.floor(now.getTime() / 1000);
    expect(
      verifyWebhookSignature({
        payload,
        header: `t=${timestamp},v1=${sign(timestamp, payload, "old")},v1=${sign(timestamp)}`,
        secret,
        now,
      }),
    ).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    const timestamp = Math.floor(now.getTime() / 1000);
    expect(
      verifyWebhookSignature({
        payload,
        header: `t=${timestamp},v1=${sign(timestamp, payload, "wrong")}`,
        secret,
        now,
      }),
    ).toBe(false);
  });

  it("rejects a body that differs by a single byte", () => {
    const timestamp = Math.floor(now.getTime() / 1000);
    expect(
      verifyWebhookSignature({
        payload: `${payload} `,
        header: `t=${timestamp},v1=${sign(timestamp)}`,
        secret,
        now,
      }),
    ).toBe(false);
  });

  it("rejects a captured delivery replayed outside the tolerance window", () => {
    const stale = Math.floor(now.getTime() / 1000) - 3600;
    expect(
      verifyWebhookSignature({
        payload,
        header: `t=${stale},v1=${sign(stale)}`,
        secret,
        now,
      }),
    ).toBe(false);
  });

  it("rejects a missing, empty, or malformed header", () => {
    for (const header of [null, "", "v1=abc", "t=nope,v1=abc"])
      expect(verifyWebhookSignature({ payload, header, secret, now })).toBe(
        false,
      );
  });
});

describe("subscription normalization", () => {
  const base = {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    items: { data: [{ price: { id: "price_123" } }] },
  };

  it("reads the period from the top level when the API version reports it there", () => {
    const normalized = normalizeSubscription({
      ...base,
      current_period_start: 1_760_000_000,
      current_period_end: 1_762_000_000,
    });
    expect(normalized.currentPeriodStart).toEqual(
      new Date(1_760_000_000 * 1000),
    );
    expect(normalized.priceId).toBe("price_123");
    expect(normalized.customerId).toBe("cus_1");
  });

  it("falls back to the subscription item's period on newer API versions", () => {
    const normalized = normalizeSubscription({
      ...base,
      items: {
        data: [
          {
            price: { id: "price_123" },
            current_period_start: 1_760_000_000,
            current_period_end: 1_762_000_000,
          },
        ],
      },
    });
    expect(normalized.currentPeriodEnd).toEqual(new Date(1_762_000_000 * 1000));
  });

  it("refuses a subscription with no billing period rather than inventing one", () => {
    expect(() => normalizeSubscription(base)).toThrow(
      "Subscription has no billing period",
    );
  });

  it("carries the workspace stamped at checkout", () => {
    const normalized = normalizeSubscription({
      ...base,
      current_period_start: 1_760_000_000,
      current_period_end: 1_762_000_000,
      metadata: { workspaceId: "workspace-1" },
    });
    expect(normalized.workspaceId).toBe("workspace-1");
  });
});
