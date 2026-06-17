/**
 * Runtime configuration, resolved once at boot.
 *
 * Self-host mode is the default: with REQUIRE_AUTH unset/false the relay runs
 * with no accounts, no billing, and unlimited delivery — the free tier. Setting
 * REQUIRE_AUTH=true turns on magic-link accounts + Stripe Pro gating (hosted).
 */
function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:8787",
  dbPath: process.env.DB_PATH ?? "./relay.db",

  /** Hosted mode toggle. Drives /health.requiresAuth so the app adapts. */
  requireAuth: bool(process.env.REQUIRE_AUTH, false),

  admin: {
    secret: process.env.ADMIN_SECRET ?? "",
  },

  mail: {
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.MAIL_FROM ?? "TradingView Alerts <noreply@localhost>",
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    priceMonthly: process.env.STRIPE_PRICE_MONTHLY ?? "",
    priceYearly: process.env.STRIPE_PRICE_YEARLY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    portalConfigId: process.env.STRIPE_PORTAL_CONFIG_ID ?? "",
  },

  /** Durable offline queue bounds, mirroring the original relay (7d / 200). */
  queue: {
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    maxPerAccount: 200,
  },
} as const;

export const billingEnabled = (): boolean =>
  config.requireAuth && config.stripe.secretKey.length > 0;
