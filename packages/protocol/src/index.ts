import { z } from "zod";

/**
 * The canonical alert shape after the relay parses a TradingView webhook.
 *
 * TradingView lets users send either a free-form text body or a JSON body in
 * the alert's "message" field. We accept both: `raw` always holds the original
 * payload so nothing is ever lost, while the parsed fields are best-effort.
 */
export const AlertSchema = z.object({
  /** Stable unique id assigned by the relay on receipt. */
  id: z.string().min(1),
  /** Epoch milliseconds the relay received the webhook. */
  receivedAt: z.number().int().nonnegative(),
  /** Best-effort ticker symbol extracted from the payload (e.g. "BTCUSD"). */
  symbol: z.string().optional(),
  /** Human-readable alert text shown in the notification + list row. */
  message: z.string(),
  /** Original webhook body, verbatim, for power users and debugging. */
  raw: z.string(),
});
export type Alert = z.infer<typeof AlertSchema>;

/**
 * Messages the relay pushes to the desktop app over the WebSocket.
 * Discriminated on `type` so both ends share one exhaustive switch.
 */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  /** Sent immediately after a socket authenticates. */
  z.object({
    type: z.literal("welcome"),
    pro: z.boolean(),
    /** Server time so the client can reconcile clock skew on relative stamps. */
    serverTime: z.number().int().nonnegative(),
  }),
  /** A real alert to display. */
  z.object({
    type: z.literal("alert"),
    alert: AlertSchema,
  }),
  /** Pro-gate upsell: a hook fired for a non-Pro account, so we nudge instead. */
  z.object({
    type: z.literal("limit"),
    reason: z.string(),
    /** Deep link the client opens to start checkout. */
    upgradeUrl: z.string().url().optional(),
  }),
  /** Live subscription change pushed from the Stripe webhook handler. */
  z.object({
    type: z.literal("entitlement"),
    pro: z.boolean(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/**
 * Messages the desktop app sends up to the relay over the WebSocket.
 * Currently only a heartbeat; kept as a union so it can grow safely.
 */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Shape returned by `GET /health` — lets the app auto-detect self-host mode. */
export const HealthSchema = z.object({
  ok: z.literal(true),
  /** When false, the app skips sign-in entirely (self-hosted, no accounts). */
  requiresAuth: z.boolean(),
  connections: z.number().int().nonnegative(),
});
export type Health = z.infer<typeof HealthSchema>;

/** Account snapshot from `GET /me`. */
export const AccountSchema = z.object({
  email: z.string().email(),
  pro: z.boolean(),
  hookUrl: z.string().url(),
  portalUrl: z.string().url().optional(),
});
export type Account = z.infer<typeof AccountSchema>;

export const WS_PATH = "/ws";
export const PROTOCOL_VERSION = 1 as const;
