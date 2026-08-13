import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BillingConfigurationError } from "./plans";

/**
 * A hand-rolled Stripe client over `fetch`, matching how every other external
 * provider in this repo is reached: no SDK, requests built here, responses
 * validated with zod at the boundary. Only the four calls Cap makes are
 * implemented, which keeps the surface small enough to read in one sitting.
 */

const STRIPE_API = "https://api.stripe.com/v1";
/** Pinned so a Stripe-side default bump cannot silently reshape a response. */
const STRIPE_API_VERSION = "2024-06-20";
const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StripeRequestError";
  }
}

function secretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new BillingConfigurationError("BILLING_NOT_CONFIGURED");
  return key;
}

/** True when this deployment can talk to Stripe at all. */
export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/**
 * Stripe takes form-encoded bodies with bracketed paths for nested values —
 * `line_items[0][price]=price_123`. Undefined entries are dropped so callers
 * can pass optional fields without building the payload conditionally.
 */
function formEncode(
  value: unknown,
  prefix = "",
  target = new URLSearchParams(),
): URLSearchParams {
  if (value === undefined || value === null) return target;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      formEncode(item, `${prefix}[${index}]`, target),
    );
    return target;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value))
      formEncode(item, prefix ? `${prefix}[${key}]` : key, target);
    return target;
  }
  target.append(prefix, String(value));
  return target;
}

async function stripeRequest<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  init: { method: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<z.infer<T>> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${secretKey()}`,
      "stripe-version": STRIPE_API_VERSION,
      ...(init.body
        ? { "content-type": "application/x-www-form-urlencoded" }
        : {}),
    },
    ...(init.body ? { body: formEncode(init.body).toString() } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ??
      `Stripe returned ${response.status}`;
    throw new StripeRequestError(response.status, message);
  }
  return schema.parse(payload);
}

const redirectSchema = z.object({ id: z.string(), url: z.string().url() });

/**
 * Stripe moved the billing period onto subscription items in later API
 * versions and kept the top-level fields on earlier ones. Accept either so a
 * deployment that pins a different version still records a correct period.
 */
const subscriptionSchema = z.object({
  id: z.string(),
  status: z.string(),
  customer: z.union([z.string(), z.object({ id: z.string() })]),
  cancel_at_period_end: z.boolean().optional(),
  current_period_start: z.number().int().optional(),
  current_period_end: z.number().int().optional(),
  metadata: z.record(z.string()).optional(),
  items: z
    .object({
      data: z
        .array(
          z.object({
            price: z.object({ id: z.string() }),
            current_period_start: z.number().int().optional(),
            current_period_end: z.number().int().optional(),
          }),
        )
        .min(1),
    })
    .optional(),
});

export type StripeSubscription = z.infer<typeof subscriptionSchema>;

export interface NormalizedSubscription {
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly status: string;
  readonly priceId: string | undefined;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
  readonly workspaceId: string | undefined;
}

export function normalizeSubscription(
  subscription: StripeSubscription,
): NormalizedSubscription {
  const item = subscription.items?.data[0];
  const start = subscription.current_period_start ?? item?.current_period_start;
  const end = subscription.current_period_end ?? item?.current_period_end;
  if (start === undefined || end === undefined)
    throw new StripeRequestError(502, "Subscription has no billing period");
  return {
    subscriptionId: subscription.id,
    customerId:
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id,
    status: subscription.status,
    priceId: item?.price.id,
    currentPeriodStart: new Date(start * 1000),
    currentPeriodEnd: new Date(end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
    workspaceId: subscription.metadata?.workspaceId,
  };
}

export async function createCheckoutSession(input: {
  readonly priceId: string;
  readonly workspaceId: string;
  readonly customerId?: string | undefined;
  readonly customerEmail?: string | undefined;
  readonly successUrl: string;
  readonly cancelUrl: string;
}) {
  return stripeRequest("/checkout/sessions", redirectSchema, {
    method: "POST",
    body: {
      mode: "subscription",
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.workspaceId,
      // Stamped on the subscription so later `customer.subscription.*` events
      // resolve their workspace without a customer lookup.
      subscription_data: { metadata: { workspaceId: input.workspaceId } },
      metadata: { workspaceId: input.workspaceId },
      ...(input.customerId
        ? { customer: input.customerId }
        : input.customerEmail
          ? { customer_email: input.customerEmail }
          : {}),
    },
  });
}

export async function createPortalSession(input: {
  readonly customerId: string;
  readonly returnUrl: string;
}) {
  return stripeRequest("/billing_portal/sessions", redirectSchema, {
    method: "POST",
    body: { customer: input.customerId, return_url: input.returnUrl },
  });
}

export async function retrieveSubscription(subscriptionId: string) {
  return stripeRequest(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    subscriptionSchema,
    { method: "GET" },
  );
}

const checkoutSessionSchema = z.object({
  id: z.string(),
  client_reference_id: z.string().nullable().optional(),
  customer: z.union([z.string(), z.object({ id: z.string() })]).nullable(),
  subscription: z.union([z.string(), subscriptionSchema]).nullable().optional(),
  metadata: z.record(z.string()).nullable().optional(),
});

export const stripeEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ object: z.unknown() }),
});

export type StripeEvent = z.infer<typeof stripeEventSchema>;

export function parseCheckoutSession(object: unknown) {
  return checkoutSessionSchema.parse(object);
}

export function parseSubscription(object: unknown) {
  return subscriptionSchema.parse(object);
}

/**
 * Verifies the `Stripe-Signature` header against the raw request body.
 *
 * The body must be the exact bytes Stripe sent — re-serializing the parsed JSON
 * changes them and the MAC will never match. Comparison is timing-safe, and a
 * stale timestamp is rejected so a captured delivery cannot be replayed
 * indefinitely.
 */
export function verifyWebhookSignature(input: {
  readonly payload: string;
  readonly header: string | null;
  readonly secret: string;
  readonly now?: Date;
}): boolean {
  if (!input.header) return false;
  const parts = new Map<string, string[]>();
  for (const segment of input.header.split(",")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  const timestamp = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!timestamp || !signatures.length) return false;
  const issuedAt = Number(timestamp);
  if (!Number.isFinite(issuedAt)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - issuedAt) > SIGNATURE_TOLERANCE_SECONDS)
    return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.payload}`, "utf8")
    .digest();
  return signatures.some((candidate) => {
    const provided = Buffer.from(candidate, "hex");
    return (
      provided.byteLength === expected.byteLength &&
      timingSafeEqual(provided, expected)
    );
  });
}

export function webhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new BillingConfigurationError("BILLING_NOT_CONFIGURED");
  return secret;
}
