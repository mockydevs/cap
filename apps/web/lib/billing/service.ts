import { and, eq, gte, sql } from "drizzle-orm";
import type { AiSubscriptionFacts } from "@cap/ai";
import { db } from "../../db/client";
import {
  aiUsageEvents,
  billingEvents,
  workspaceSubscriptions,
} from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import type { Actor } from "../auth/session";
import { publicAppUrl } from "../auth/origin";
import {
  aiPlans,
  BillingConfigurationError,
  managedMarkupPercent,
  planByCode,
  planByPriceId,
  type AiPlan,
} from "./plans";
import {
  createCheckoutSession,
  createPortalSession,
  normalizeSubscription,
  parseCheckoutSession,
  parseSubscription,
  retrieveSubscription,
  stripeConfigured,
  type StripeEvent,
} from "./stripe";

export class BillingServiceError extends Error {
  constructor(
    readonly code:
      | "BILLING_NOT_CONFIGURED"
      | "BILLING_PLAN_NOT_FOUND"
      | "BILLING_NO_SUBSCRIPTION"
      | "BILLING_PROVIDER_FAILED",
    readonly status: number,
  ) {
    super(code);
    this.name = "BillingServiceError";
  }
}

type SubscriptionStatus =
  (typeof workspaceSubscriptions.status.enumValues)[number];

/**
 * Stripe's statuses collapse to the four Cap distinguishes. Anything that is
 * not a live, paid-for state maps to CANCELED so the entitlement resolver
 * treats it as absent rather than having to know Stripe's vocabulary.
 */
const STATUS_BY_STRIPE: Readonly<Record<string, SubscriptionStatus>> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  unpaid: "UNPAID",
  incomplete: "INCOMPLETE",
  incomplete_expired: "CANCELED",
  canceled: "CANCELED",
  paused: "CANCELED",
};

/**
 * Managed-lane spend for a period, summed from the usage ledger rather than
 * stored on the subscription, so a credit balance can never drift from the
 * work it was spent on.
 */
async function consumedCredit(workspaceId: string, since: Date) {
  const [row] = await db()
    .select({
      charged: sql<number>`coalesce(sum(${aiUsageEvents.chargedMicrounits}),0)::bigint`,
    })
    .from(aiUsageEvents)
    .where(
      and(
        eq(aiUsageEvents.workspaceId, workspaceId),
        eq(aiUsageEvents.lane, "MANAGED"),
        gte(aiUsageEvents.occurredAt, since),
      ),
    );
  return Number(row?.charged ?? 0);
}

/**
 * The subscription facts the AI entitlement resolver needs. Returns null when
 * this deployment sells no plans, when the workspace has none, or when the
 * stored plan is no longer in the catalogue — in every case the managed lane
 * is simply unavailable.
 */
export async function loadSubscriptionFacts(
  workspaceId: string,
): Promise<AiSubscriptionFacts | null> {
  if (!aiPlans().length) return null;
  const [subscription] = await db()
    .select()
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, workspaceId))
    .limit(1);
  if (!subscription) return null;
  return {
    status: subscription.status,
    planCode: subscription.planCode,
    currentPeriodEnd: subscription.currentPeriodEnd,
    includedCreditMicrounits: subscription.includedCreditMicrounits,
    consumedCreditMicrounits: await consumedCredit(
      workspaceId,
      subscription.currentPeriodStart,
    ),
  };
}

export interface BillingOverview {
  readonly available: boolean;
  readonly markupPercent: number;
  readonly plans: AiPlan[];
  readonly subscription: {
    readonly planCode: string;
    readonly planLabel: string;
    readonly status: SubscriptionStatus;
    readonly currentPeriodEnd: string;
    readonly cancelAtPeriodEnd: boolean;
    readonly includedCreditMicrounits: number;
    readonly consumedCreditMicrounits: number;
  } | null;
}

export async function getBillingOverview(
  actor: Actor,
): Promise<BillingOverview> {
  const plans = aiPlans();
  const available = plans.length > 0 && stripeConfigured();
  const [subscription] = await db()
    .select()
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, actor.workspaceId))
    .limit(1);
  return {
    available,
    markupPercent: managedMarkupPercent(),
    plans,
    subscription: subscription
      ? {
          planCode: subscription.planCode,
          planLabel:
            plans.find((plan) => plan.code === subscription.planCode)?.label ??
            subscription.planCode,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          includedCreditMicrounits: subscription.includedCreditMicrounits,
          consumedCreditMicrounits: await consumedCredit(
            actor.workspaceId,
            subscription.currentPeriodStart,
          ),
        }
      : null,
  };
}

function requireProvider() {
  if (!stripeConfigured() || !aiPlans().length)
    throw new BillingServiceError("BILLING_NOT_CONFIGURED", 503);
}

export async function startPlanCheckout(actor: Actor, planCode: string) {
  requireProvider();
  let plan: AiPlan;
  try {
    plan = planByCode(planCode);
  } catch (error) {
    if (error instanceof BillingConfigurationError)
      throw new BillingServiceError("BILLING_PLAN_NOT_FOUND", 404);
    throw error;
  }
  const [existing] = await db()
    .select({ customerId: workspaceSubscriptions.customerId })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, actor.workspaceId))
    .limit(1);
  const session = await createCheckoutSession({
    priceId: plan.priceId,
    workspaceId: actor.workspaceId,
    ...(existing?.customerId ? { customerId: existing.customerId } : {}),
    customerEmail: actor.email,
    successUrl: publicAppUrl("/admin?billing=success#ai").toString(),
    cancelUrl: publicAppUrl("/admin?billing=cancelled#ai").toString(),
  });
  await recordAuditEvent(db(), {
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action: "billing.checkout_started",
    targetType: "workspace_subscription",
    targetId: actor.workspaceId,
    metadata: { planCode: plan.code },
  });
  return { url: session.url };
}

export async function openBillingPortal(actor: Actor) {
  requireProvider();
  const [subscription] = await db()
    .select({ customerId: workspaceSubscriptions.customerId })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, actor.workspaceId))
    .limit(1);
  if (!subscription)
    throw new BillingServiceError("BILLING_NO_SUBSCRIPTION", 404);
  const session = await createPortalSession({
    customerId: subscription.customerId,
    returnUrl: publicAppUrl("/admin#ai").toString(),
  });
  return { url: session.url };
}

async function upsertSubscription(input: {
  readonly workspaceId: string;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly planCode: string;
  readonly includedCreditMicrounits: number;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
}) {
  await db()
    .insert(workspaceSubscriptions)
    .values({ ...input, provider: "STRIPE" })
    .onConflictDoUpdate({
      target: workspaceSubscriptions.workspaceId,
      set: {
        customerId: input.customerId,
        subscriptionId: input.subscriptionId,
        planCode: input.planCode,
        includedCreditMicrounits: input.includedCreditMicrounits,
        status: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        updatedAt: new Date(),
      },
    });
}

/**
 * Resolves which workspace a subscription belongs to. The metadata stamped at
 * checkout is authoritative; the customer lookup covers subscriptions created
 * outside Cap, for example directly in the provider's dashboard.
 */
async function workspaceForSubscription(input: {
  readonly workspaceId: string | undefined;
  readonly customerId: string;
}) {
  if (input.workspaceId) return input.workspaceId;
  const [existing] = await db()
    .select({ workspaceId: workspaceSubscriptions.workspaceId })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.customerId, input.customerId))
    .limit(1);
  return existing?.workspaceId;
}

async function applySubscriptionObject(object: unknown, canceled: boolean) {
  const normalized = normalizeSubscription(parseSubscription(object));
  const workspaceId = await workspaceForSubscription(normalized);
  if (!workspaceId) return;
  const plan = normalized.priceId
    ? planByPriceId(normalized.priceId)
    : undefined;
  const [existing] = await db()
    .select({
      planCode: workspaceSubscriptions.planCode,
      includedCreditMicrounits: workspaceSubscriptions.includedCreditMicrounits,
    })
    .from(workspaceSubscriptions)
    .where(eq(workspaceSubscriptions.workspaceId, workspaceId))
    .limit(1);
  // A price that has left the catalogue keeps whatever the workspace was last
  // sold rather than dropping its credit to zero mid-period.
  const planCode = plan?.code ?? existing?.planCode;
  const includedCreditMicrounits =
    plan?.includedCreditMicrounits ?? existing?.includedCreditMicrounits;
  if (!planCode || includedCreditMicrounits === undefined) return;
  await upsertSubscription({
    workspaceId,
    customerId: normalized.customerId,
    subscriptionId: normalized.subscriptionId,
    planCode,
    includedCreditMicrounits,
    status: canceled
      ? "CANCELED"
      : (STATUS_BY_STRIPE[normalized.status] ?? "CANCELED"),
    currentPeriodStart: normalized.currentPeriodStart,
    currentPeriodEnd: normalized.currentPeriodEnd,
    cancelAtPeriodEnd: normalized.cancelAtPeriodEnd,
  });
}

async function applyCheckoutSession(object: unknown) {
  const session = parseCheckoutSession(object);
  const workspaceId =
    session.client_reference_id ?? session.metadata?.workspaceId;
  if (!workspaceId || !session.subscription) return;
  // Checkout reports the subscription as an id unless the caller expanded it;
  // fetching guarantees a period and price regardless of which shape arrived.
  const subscription =
    typeof session.subscription === "string"
      ? await retrieveSubscription(session.subscription)
      : session.subscription;
  await applySubscriptionObject(
    { ...subscription, metadata: { ...subscription.metadata, workspaceId } },
    false,
  );
}

/**
 * Applies one webhook event, at most once. The delivery id is claimed first;
 * a duplicate claim means an earlier delivery already ran and this one is a
 * no-op, which is what makes provider redelivery safe.
 */
export async function applyBillingEvent(event: StripeEvent): Promise<boolean> {
  const claimed = await db()
    .insert(billingEvents)
    .values({
      eventId: event.id,
      provider: "STRIPE",
      eventType: event.type,
    })
    .onConflictDoNothing()
    .returning({ eventId: billingEvents.eventId });
  if (!claimed.length) return false;
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await applyCheckoutSession(event.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await applySubscriptionObject(event.data.object, false);
        break;
      case "customer.subscription.deleted":
        await applySubscriptionObject(event.data.object, true);
        break;
      default:
        break;
    }
  } catch (error) {
    // Release the claim so the provider's redelivery can retry a transient
    // failure instead of the event being silently swallowed.
    await db().delete(billingEvents).where(eq(billingEvents.eventId, event.id));
    throw error;
  }
  return true;
}
