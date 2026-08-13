# Selling AI plans

Cap is bring-your-own-key by default: a workspace connects its own provider
credential and pays its own provider directly, and the deployment never carries
AI cost. This document covers the optional second lane, where the deployment
sells AI and bills for it.

Leave `AI_PLANS`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` unset and
none of this exists: the billing endpoints report `BILLING_NOT_CONFIGURED`, the
settings screen says the deployment does not sell plans, and the entitlement
resolver never offers the managed lane.

## What a plan is

A plan is a price at the billing provider plus an amount of AI credit per
billing period. Credit is denominated in microunits — USD x 10^-6, the unit
every cost column in Cap uses — so `5000000` is $5.00 of AI per period.

```
AI_PLANS=[{"code":"starter","label":"Starter","priceId":"price_123","includedCreditMicrounits":5000000}]
```

| Field                      | Meaning                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `code`                     | Stable identifier stored on the subscription and used in URLs |
| `label`                    | Shown to the customer                                         |
| `description`              | Optional line under the label                                 |
| `priceId`                  | The billing provider's recurring price                        |
| `includedCreditMicrounits` | AI spend included per billing period                          |

The catalogue is parsed and validated on every read, so a corrected value takes
effect on restart rather than requiring a redeploy. A malformed `AI_PLANS`
fails the billing endpoints with a 503 and leaves the rest of the app working.

`AI_MANAGED_MARKUP_PERCENT` is the margin added to metered provider cost before
it is drawn from credit. It defaults to `0`, so a deployment that forgets to set
it resells at cost rather than silently overcharging.

## Trial credit

`AI_TRIAL_CREDIT_MICROUNITS` gives a workspace a lifetime allowance before it
has connected a key or bought anything, so a new signup can try transcription
and analysis instead of hitting a refusal on its first recording. It defaults
to `0` — the deployment pays for it out of `AI_API_KEY`, so it is opt-in.

Trial spend rides the managed lane and is recorded with plan code `trial`, so
it appears in the ledger like any other charge and is measured over the
workspace's lifetime rather than a billing period. A routed key or a real
subscription always takes precedence, and a spent trial reports
`AI_CREDIT_EXHAUSTED` so the UI prompts for a key or a plan.

## How credit is consumed

Nothing is deducted up front. Each completed unit of AI work writes an
`ai_usage_events` row carrying both its estimated provider cost and, for the
managed lane only, the `charged_microunits` drawn from credit. Remaining credit
is `included − sum(charged this period)`, computed from the ledger rather than
stored, so a balance can never drift from the work it was spent on.

When credit runs out the workspace is refused with `AI_CREDIT_EXHAUSTED` — it is
not quietly moved onto the deployment's own credential. Connecting a provider
key clears the refusal immediately, because a routed key always takes precedence
over a plan.

## Stripe setup

Cap talks to Stripe over its REST API with `fetch`; there is no SDK dependency.

1. Create a recurring price per plan and put its id in `AI_PLANS`.
2. Set `STRIPE_SECRET_KEY`.
3. Register a webhook endpoint at `${NEXT_PUBLIC_APP_URL}/api/billing/webhook`
   subscribed to `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`, and
   `customer.subscription.deleted`. Put its signing secret in
   `STRIPE_WEBHOOK_SECRET`.

The endpoint is unauthenticated by design — the signature over the raw request
body is the authentication. Signatures are compared in constant time and a
delivery older than five minutes is rejected, so a captured request cannot be
replayed indefinitely. Every delivery id is claimed in `billing_events` before
the event is applied, which makes Stripe's redelivery safe; a failure releases
the claim so the retry can succeed.

Cap stamps `workspaceId` on the checkout session and on the subscription's
metadata, so later subscription events resolve their workspace without a lookup.
A subscription created directly in the Stripe dashboard is matched by customer
id instead.

## What Cap stores

`workspace_subscriptions` mirrors the provider and is never the source of truth:
customer and subscription ids, plan code, status, current period, included
credit, and whether it cancels at period end. Statuses collapse to the four the
entitlement resolver distinguishes, so nothing outside `lib/billing` needs to
know Stripe's vocabulary.

If a price leaves the catalogue while a workspace is subscribed to it, the
stored plan code and credit are kept rather than dropped to zero mid-period.

## Operating notes

- Admins start checkout and open the billing portal; any member can read the
  plan status, because members are the ones who hit the refusals.
- Cancelling leaves `status` ACTIVE until the period ends, so credit remains
  spendable for what the customer already paid for.
- The managed lane needs `AI_API_KEY` set, since the deployment's credential is
  what performs the work it bills for. That is the one case where the key is
  spent without `AI_ALLOW_DEPLOYMENT_CREDENTIAL=true` — and it is spent against
  a subscription that paid for it.
