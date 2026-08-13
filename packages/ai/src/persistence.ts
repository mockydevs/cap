import {
  resolveAiEntitlement,
  type AiEntitlement,
  type AiPurpose,
  type AiUsageLane,
  type AiUsageUnitKind,
} from "./entitlement";
import { applyManagedMarkup } from "./rates";

/**
 * Worker-side entitlement loading.
 *
 * The web app reads these same facts through Drizzle; the workers use raw SQL
 * against a pooled client. Rather than let each worker write its own query —
 * which is how transcription came to skip the workspace policy entirely — the
 * statements live here once, beside the resolver they feed.
 *
 * The executor is structural (`pg`'s Pool and PoolClient both satisfy it), so
 * this package needs no database driver of its own.
 */
export interface SqlExecutor {
  query<Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

/** Postgres returns `bigint` as a string; every count here is safe in a double. */
const count = (value: unknown): number => Number(value ?? 0);

/** Start of the current UTC calendar month, as a timestamptz. */
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

export async function loadAiEntitlement(
  executor: SqlExecutor,
  input: {
    readonly workspaceId: string;
    readonly purpose: AiPurpose;
    readonly deploymentCredentialAllowed: boolean;
    readonly now?: Date;
  },
): Promise<AiEntitlement> {
  const policy = await executor.query<{
    enabled: boolean;
    allowed_provider: string;
    allow_external_processing: boolean;
    monthly_token_limit: number;
    monthly_cost_limit_microunits: string;
  }>(
    "SELECT enabled,allowed_provider,allow_external_processing,monthly_token_limit,monthly_cost_limit_microunits FROM ai_workspace_policies WHERE workspace_id=$1",
    [input.workspaceId],
  );
  const route = await executor.query<{ connection_id: string; model: string }>(
    "SELECT r.connection_id,r.model FROM ai_provider_routes r JOIN ai_provider_connections c ON c.id=r.connection_id AND c.workspace_id=r.workspace_id AND c.status='ACTIVE' WHERE r.workspace_id=$1 AND r.purpose=$2 LIMIT 1",
    [input.workspaceId, input.purpose],
  );
  const usage = await executor.query<{ tokens: string; cost: string }>(
    `SELECT coalesce(sum(units) FILTER (WHERE unit_kind='TOKENS'),0) tokens, coalesce(sum(cost_microunits),0) cost FROM ai_usage_events WHERE workspace_id=$1 AND occurred_at >= ${MONTH_START}`,
    [input.workspaceId],
  );
  const subscription = await executor.query<{
    status: string;
    plan_code: string;
    current_period_end: Date;
    included_credit_microunits: string;
    consumed: string;
  }>(
    "SELECT s.status,s.plan_code,s.current_period_end,s.included_credit_microunits,(SELECT coalesce(sum(e.charged_microunits),0) FROM ai_usage_events e WHERE e.workspace_id=s.workspace_id AND e.lane='MANAGED' AND e.occurred_at >= s.current_period_start) consumed FROM workspace_subscriptions s WHERE s.workspace_id=$1",
    [input.workspaceId],
  );
  const policyRow = policy.rows[0];
  const subscriptionRow = subscription.rows[0];
  return resolveAiEntitlement({
    purpose: input.purpose,
    policy: policyRow
      ? {
          enabled: policyRow.enabled,
          allowedProvider: policyRow.allowed_provider,
          allowExternalProcessing: policyRow.allow_external_processing,
          monthlyTokenLimit: count(policyRow.monthly_token_limit),
          monthlyCostLimitMicrounits: count(
            policyRow.monthly_cost_limit_microunits,
          ),
        }
      : null,
    route: route.rows[0]
      ? {
          connectionId: route.rows[0].connection_id,
          model: route.rows[0].model,
        }
      : null,
    subscription: subscriptionRow
      ? {
          status: subscriptionRow.status,
          planCode: subscriptionRow.plan_code,
          currentPeriodEnd: new Date(subscriptionRow.current_period_end),
          includedCreditMicrounits: count(
            subscriptionRow.included_credit_microunits,
          ),
          consumedCreditMicrounits: count(subscriptionRow.consumed),
        }
      : null,
    usage: {
      tokens: count(usage.rows[0]?.tokens),
      costMicrounits: count(usage.rows[0]?.cost),
    },
    deploymentCredentialAllowed: input.deploymentCredentialAllowed,
    now: input.now ?? new Date(),
  });
}

/**
 * Appends one metered unit of work to the ledger. Written inside the same
 * transaction that records the job or run it belongs to, and ignored on
 * conflict so a retry cannot bill twice.
 */
export async function recordAiUsage(
  executor: SqlExecutor,
  input: {
    readonly workspaceId: string;
    readonly purpose: AiPurpose;
    readonly lane: AiUsageLane;
    readonly sourceKind: "AI_JOB" | "TRANSCRIPTION_RUN" | "EMBEDDING_BATCH";
    readonly sourceId: string;
    readonly connectionId: string | null;
    readonly provider: string;
    readonly model: string;
    readonly units: number;
    readonly unitKind: AiUsageUnitKind;
    readonly inputTokens?: number | undefined;
    readonly outputTokens?: number | undefined;
    readonly costMicrounits: number;
    readonly currency?: string | undefined;
    readonly markupPercent?: number | undefined;
  },
): Promise<void> {
  await executor.query(
    "INSERT INTO ai_usage_events (workspace_id,purpose,lane,source_kind,source_id,connection_id,provider,model,units,unit_kind,input_tokens,output_tokens,cost_microunits,charged_microunits,currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (source_kind,source_id) DO NOTHING",
    [
      input.workspaceId,
      input.purpose,
      input.lane,
      input.sourceKind,
      input.sourceId,
      input.connectionId,
      input.provider,
      input.model,
      Math.max(0, Math.round(input.units)),
      input.unitKind,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      Math.max(0, Math.round(input.costMicrounits)),
      // Only the managed lane draws plan credit; a workspace on its own key is
      // metered for its ceiling and charged nothing.
      input.lane === "MANAGED"
        ? applyManagedMarkup(input.costMicrounits, input.markupPercent ?? 0)
        : 0,
      input.currency ?? "USD",
    ],
  );
}

/** Reads the deployment's resale margin, shared by both workers. */
export function managedMarkupPercentFromEnvironment(
  environment: Record<string, string | undefined>,
): number {
  const configured = Number(environment.AI_MANAGED_MARKUP_PERCENT ?? "0");
  if (!Number.isFinite(configured) || configured < 0) return 0;
  return Math.trunc(configured);
}
