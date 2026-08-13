"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchFresh, sendJson } from "../lib/http/json";
import { formatMicrounits } from "../lib/ai/messages";

type Plan = {
  code: string;
  label: string;
  description?: string;
  priceId: string;
  includedCreditMicrounits: number;
};

type Overview = {
  available: boolean;
  markupPercent: number;
  plans: Plan[];
  subscription: {
    planCode: string;
    planLabel: string;
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    includedCreditMicrounits: number;
    consumedCreditMicrounits: number;
  } | null;
};

/**
 * The second way a workspace can pay for AI: a Cap plan, billed by the
 * deployment, drawn down as work is metered. It sits beside the bring-your-own-key
 * card because they are alternatives — a routed key always takes precedence,
 * and this is what covers the purposes it does not.
 */
export function BillingSettings() {
  const [overview, setOverview] = useState<Overview>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetchFresh("/api/billing");
    if (response.ok) setOverview((await response.json()) as Overview);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!overview) return null;
  if (!overview.available)
    return (
      <div className="admin-note">
        <p>
          This deployment does not sell AI plans. Connect your own provider key
          above to enable AI features.
        </p>
      </div>
    );

  const redirect = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setMessage(undefined);
    const response = await sendJson(path, "POST", body ?? {});
    setBusy(false);
    if (!response.ok) {
      setMessage("Could not reach the billing provider. Try again shortly.");
      return;
    }
    const { url } = (await response.json()) as { url: string };
    window.location.assign(url);
  };

  const { subscription } = overview;
  const remaining = subscription
    ? Math.max(
        0,
        subscription.includedCreditMicrounits -
          subscription.consumedCreditMicrounits,
      )
    : 0;

  return (
    <div className="billing-settings">
      {subscription ? (
        <>
          <dl className="admin-metrics">
            <div>
              <dt>Plan</dt>
              <dd>
                {subscription.planLabel} · {subscription.status.toLowerCase()}
              </dd>
            </div>
            <div>
              <dt>Credit used this period</dt>
              <dd>
                {formatMicrounits(subscription.consumedCreditMicrounits)} of{" "}
                {formatMicrounits(subscription.includedCreditMicrounits)}
              </dd>
            </div>
            <div>
              <dt>Remaining</dt>
              <dd>{formatMicrounits(remaining)}</dd>
            </div>
            <div>
              <dt>{subscription.cancelAtPeriodEnd ? "Ends" : "Renews"}</dt>
              <dd>
                {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            disabled={busy}
            onClick={() => void redirect("/api/billing/portal")}
          >
            Manage billing
          </button>
        </>
      ) : (
        <>
          <p>
            Start a plan to use AI features without supplying your own provider
            key. Usage is metered at provider cost
            {overview.markupPercent > 0
              ? ` plus ${overview.markupPercent}%`
              : ""}{" "}
            and drawn from the plan&rsquo;s included credit.
          </p>
          <ul className="plan-list">
            {overview.plans.map((plan) => (
              <li key={plan.code}>
                <strong>{plan.label}</strong>
                <span>
                  {formatMicrounits(plan.includedCreditMicrounits)} of AI credit
                  per period
                </span>
                {plan.description ? <span>{plan.description}</span> : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void redirect("/api/billing/checkout", {
                      planCode: plan.code,
                    })
                  }
                >
                  Choose {plan.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {message ? <p className="form-error">{message}</p> : null}
    </div>
  );
}
