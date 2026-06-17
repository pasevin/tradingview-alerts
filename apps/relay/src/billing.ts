/**
 * Stripe billing. Subscription Checkout + Customer Portal + signature-verified
 * webhook. The webhook is the single authority that flips an account's Pro
 * flag; the desktop client never decides entitlement for itself.
 */
import Stripe from "stripe";
import { config, billingEnabled } from "./config.js";
import { accounts } from "./db.js";
import { hub } from "./hub.js";
import type { Account } from "./db.js";

const stripe = config.stripe.secretKey
  ? new Stripe(config.stripe.secretKey)
  : null;

export function priceFor(plan: "monthly" | "yearly"): string {
  return plan === "yearly"
    ? config.stripe.priceYearly
    : config.stripe.priceMonthly;
}

export async function createCheckout(
  account: Account,
  plan: "monthly" | "yearly",
): Promise<string> {
  if (!stripe) throw new Error("billing-disabled");
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceFor(plan), quantity: 1 }],
    customer_email: account.stripeCustomerId ? undefined : account.email,
    customer: account.stripeCustomerId ?? undefined,
    client_reference_id: account.id,
    success_url: `${config.publicBaseUrl}/billing/done?ok=1`,
    cancel_url: `${config.publicBaseUrl}/billing/done?ok=0`,
  });
  if (!session.url) throw new Error("no-checkout-url");
  return session.url;
}

export async function createPortal(account: Account): Promise<string> {
  if (!stripe || !account.stripeCustomerId) throw new Error("no-customer");
  const session = await stripe.billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: `${config.publicBaseUrl}/billing/done?ok=1`,
    configuration: config.stripe.portalConfigId || undefined,
  });
  return session.url;
}

/**
 * Verify the Stripe signature, then reconcile Pro state. Pushing a live
 * `entitlement` message means the app reflects an upgrade without a restart.
 */
export function handleWebhook(rawBody: Buffer, signature: string): void {
  if (!stripe) throw new Error("billing-disabled");
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    config.stripe.webhookSecret,
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const accountId = s.client_reference_id;
      const customerId =
        typeof s.customer === "string" ? s.customer : s.customer?.id;
      if (accountId) {
        accounts.setPro(accountId, true, customerId ?? undefined);
        hub.send(accountId, { type: "entitlement", pro: true });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const account = accounts.byStripeCustomer(customerId);
      if (account) {
        const active = sub.status === "active" || sub.status === "trialing";
        accounts.setPro(account.id, active);
        hub.send(account.id, { type: "entitlement", pro: active });
      }
      break;
    }
    default:
      break;
  }
}

export { billingEnabled };
