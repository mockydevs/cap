import { z } from "zod";

/**
 * The plans a deployment sells. Cap ships none: an operator who wants to resell
 * AI declares the catalogue here, and one that only supports bring-your-own-key
 * leaves it unset, which makes the managed lane simply unavailable rather than
 * half-configured.
 */
export class BillingConfigurationError extends Error {
  constructor(
    readonly code:
      | "BILLING_NOT_CONFIGURED"
      | "BILLING_PLANS_INVALID"
      | "BILLING_PLAN_NOT_FOUND",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BillingConfigurationError";
  }
}

const aiPlanSchema = z
  .object({
    /** Stable identifier stored on the subscription; safe to show in a URL. */
    code: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(200).optional(),
    /** The billing provider's price identifier. */
    priceId: z.string().trim().min(1).max(120),
    /**
     * AI spend included per billing period, in microunits. Consumption is
     * metered at provider cost plus the deployment's markup, so this is the
     * ceiling the workspace actually gets.
     */
    includedCreditMicrounits: z
      .number()
      .int()
      .positive()
      .max(1_000_000_000_000),
  })
  .strict();

export type AiPlan = z.infer<typeof aiPlanSchema>;

const catalogueSchema = z
  .array(aiPlanSchema)
  .max(12)
  .superRefine((plans, ctx) => {
    for (const key of ["code", "priceId"] as const) {
      const values = plans.map((plan) => plan[key]);
      if (new Set(values).size !== values.length)
        ctx.addIssue({
          code: "custom",
          message: `Plan ${key} must be unique`,
          path: [key],
        });
    }
  });

/**
 * Parsed on every call rather than cached at module load: the catalogue is
 * small, and a cached parse would make a corrected `AI_PLANS` require a
 * redeploy instead of a restart.
 */
export function aiPlans(): AiPlan[] {
  const raw = process.env.AI_PLANS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BillingConfigurationError(
      "BILLING_PLANS_INVALID",
      "AI_PLANS must be a JSON array",
    );
  }
  const result = catalogueSchema.safeParse(parsed);
  if (!result.success)
    throw new BillingConfigurationError(
      "BILLING_PLANS_INVALID",
      "AI_PLANS does not match the plan schema",
    );
  return result.data;
}

export function planByCode(code: string): AiPlan {
  const plan = aiPlans().find((candidate) => candidate.code === code);
  if (!plan) throw new BillingConfigurationError("BILLING_PLAN_NOT_FOUND");
  return plan;
}

/** Undefined rather than throwing: a stored plan may have been retired. */
export function planByPriceId(priceId: string): AiPlan | undefined {
  return aiPlans().find((candidate) => candidate.priceId === priceId);
}

/**
 * Margin added to metered provider cost before it is drawn from plan credit.
 * Defaults to zero so a misconfigured deployment resells at cost rather than
 * silently overcharging a customer.
 */
export function managedMarkupPercent(): number {
  const configured = Number(process.env.AI_MANAGED_MARKUP_PERCENT ?? "0");
  if (!Number.isFinite(configured) || configured < 0) return 0;
  return Math.trunc(configured);
}
