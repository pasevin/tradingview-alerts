/**
 * Relay HTTP + WebSocket server (Fastify 5). Implements the endpoint contract
 * shared with the original relay: health, magic-link auth, register, billing,
 * the public webhook, and the app WebSocket.
 *
 * Two modes (see config.ts):
 *   - self-host (REQUIRE_AUTH unset): no accounts, unlimited, a single shared
 *     token; /health advertises requiresAuth:false so the app skips sign-in.
 *   - hosted (REQUIRE_AUTH=*** magic-link accounts + Stripe Pro gating.
 */
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config, billingEnabled } from "./config.js";
import { accounts, sessions, magicLinks, type Account } from "./db.js";
import { hub } from "./hub.js";
import { parseAlert } from "./alert.js";
import { createCheckout, createPortal, handleWebhook } from "./billing.js";
import { sendMagicLink } from "./mail.js";

const app = Fastify({ logger: true });
await app.register(websocket);

/** Self-host mode hands every caller the same unlimited account. */
function selfHostAccount(): Account {
  return accounts.upsertByEmail("self-host@localhost");
}

function bearer(req: { headers: Record<string, unknown> }): string | undefined {
  const h = req.headers.authorization;
  return typeof h === "string" && h.startsWith("Bearer ")
    ? h.slice(7)
    : undefined;
}

function requireAccount(req: {
  headers: Record<string, unknown>;
}): Account | undefined {
  if (!config.requireAuth) return selfHostAccount();
  const token = bearer(req);
  return token ? accounts.bySessionToken(token) : undefined;
}

// ── Liveness ──────────────────────────────────────────────────────────
app.get("/health", () => ({
  ok: true as const,
  requiresAuth: config.requireAuth,
  connections: hub.connectionCount,
}));

// ── Magic-link auth (hosted only) ─────────────────────────────────────
app.post<{ Body: { email?: string } }>("/auth/request", async (req, reply) => {
  const email = req.body.email?.trim().toLowerCase();
  if (!email) return reply.code(400).send({ error: "email-required" });
  const { pollToken, linkToken } = magicLinks.create(email);
  const link = `${config.publicBaseUrl}/auth/verify?token=${linkToken}`;
  await sendMagicLink(email, link);
  return { pollToken };
});

app.get<{ Querystring: { token?: string } }>("/auth/verify", (req, reply) => {
  const email = req.query.token
    ? magicLinks.consumeByLink(req.query.token)
    : undefined;
  if (!email) {
    return reply.code(400).type("text/html").send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Link expired</title>` +
      `<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f5f5f7;color:#1d1d1f}` +
      `.card{background:#fff;padding:40px 48px;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center;max-width:360px}` +
      `h1{font-size:20px;margin:0 0 8px}p{color:#6e6e73;line-height:1.5;margin:0}</style></head>` +
      `<body><div class="card"><h1>Link expired</h1><p>Please request a new sign-in link from the app.</p></div></body></html>`,
    );
  }
  accounts.upsertByEmail(email);
  return reply.type("text/html").send(
    `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>` +
    `<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f5f5f7;color:#1d1d1f}` +
    `.card{background:#fff;padding:40px 48px;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.08);text-align:center;max-width:360px}` +
    `h1{font-size:20px;margin:0 0 8px}p{color:#6e6e73;line-height:1.5;margin:0}</style></head>` +
    `<body><div class="card"><h1>✅ You're signed in</h1><p>You can close this tab and return to TradingView Alerts.</p></div></body></html>`,
  );
});

app.post<{ Body: { pollToken?: string } }>("/auth/poll", (req, reply) => {
  const status = req.body.pollToken
    ? magicLinks.pollStatus(req.body.pollToken)
    : undefined;
  if (!status) return reply.code(404).send({ status: "unknown" });
  if (!status.consumed) return { status: "pending" };
  const account = accounts.upsertByEmail(status.email);
  return {
    status: "ready",
    sessionToken: sessions.create(account.id),
    email: account.email,
    pro: account.pro === 1,
  };
});

app.post("/auth/signout", (req, reply) => {
  const token = bearer(req);
  if (token) sessions.destroy(token);
  return reply.send({ ok: true });
});

// ── Account + webhook token ───────────────────────────────────────────
app.post("/register", (req, reply) => {
  const account = requireAccount(req);
  if (!account) return reply.code(401).send({ error: "unauthorized" });
  return {
    token: account.hookToken,
    hookUrl: `${config.publicBaseUrl}/hook/${account.hookToken}`,
  };
});

app.get("/me", (req, reply) => {
  const account = requireAccount(req);
  if (!account) return reply.code(401).send({ error: "unauthorized" });
  return {
    email: account.email,
    pro: account.pro === 1,
    hookUrl: `${config.publicBaseUrl}/hook/${account.hookToken}`,
  };
});

// ── Billing (hosted only) ─────────────────────────────────────────────
app.get<{ Querystring: { plan?: string } }>(
  "/billing/checkout",
  async (req, reply) => {
    const account = requireAccount(req);
    if (!account) return reply.code(401).send({ error: "unauthorized" });
    if (!billingEnabled()) return reply.code(404).send({ error: "billing-disabled" });
    const plan = req.query.plan === "yearly" ? "yearly" : "monthly";
    return { url: await createCheckout(account, plan) };
  },
);

app.get("/billing/portal", async (req, reply) => {
  const account = requireAccount(req);
  if (!account) return reply.code(401).send({ error: "unauthorized" });
  if (!billingEnabled()) return reply.code(404).send({ error: "billing-disabled" });
  return { url: await createPortal(account) };
});

// Stripe needs the raw body for signature verification.
app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body, done) => {
    (req as { rawBody?: Buffer }).rawBody = body as Buffer;
    try {
      done(null, body.length ? JSON.parse(body.toString()) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

app.post("/billing/stripe/webhook", (req, reply) => {
  const sig = req.headers["stripe-signature"];
  const raw = (req as { rawBody?: Buffer }).rawBody;
  if (typeof sig !== "string" || !raw) {
    return reply.code(400).send({ error: "bad-signature" });
  }
  try {
    handleWebhook(raw, sig);
    return reply.send({ received: true });
  } catch {
    return reply.code(400).send({ error: "verify-failed" });
  }
});

// ── Public webhook from TradingView ───────────────────────────────────
app.post<{ Params: { token: string } }>(
  "/hook/:token",
  async (req, reply) => {
    const account = accounts.byHookToken(req.params.token);
    if (!account) return reply.code(404).send({ error: "unknown-token" });

    // Hosted Pro gate: non-Pro accounts get an upsell, not delivery.
    if (config.requireAuth && account.pro !== 1) {
      hub.send(account.id, {
        type: "limit",
        reason: "Hosted relay delivery is a Pro feature.",
        upgradeUrl: `${config.publicBaseUrl}/billing/checkout`,
      });
      return reply.code(402).send({ type: "limit" });
    }

    const raw =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    hub.deliverAlert(account.id, parseAlert(raw));
    return reply.send({ ok: true });
  },
);

// ── App WebSocket ─────────────────────────────────────────────────────
app.get<{ Querystring: { token?: string } }>(
  "/ws",
  { websocket: true },
  (socket, req) => {
    const token = req.query.token;
    const account = token ? accounts.byHookToken(token) : undefined;
    if (!account) {
      socket.close(4001, "unauthorized");
      return;
    }
    hub.add(account.id, socket);
    hub.flushBacklog(account.id, account.pro === 1);

    socket.on("close", () => hub.remove(account.id, socket));
    socket.on("message", () => {
      /* heartbeat ping; no-op beyond keeping the socket warm */
    });
  },
);

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => app.log.info(`relay up on :${config.port} (auth=${config.requireAuth})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
