/**
 * SQLite persistence (better-sqlite3, synchronous). One file on a mounted
 * volume is sufficient for launch; the schema is deliberately small so a later
 * move to LiteFS/Postgres is mechanical.
 *
 * Schema changes are handled by the migration system in migrations.ts.
 * Never use CREATE TABLE or ALTER TABLE directly here — add a migration instead.
 */
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { runMigrations } from "./migrations.js";
import type { Alert } from "@tvalert/protocol";

export interface Account {
  id: string;
  email: string;
  hookToken: string;
  pro: number; // SQLite has no boolean; 0/1
  stripeCustomerId: string | null;
}

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

// Run all pending schema migrations before any queries.
runMigrations(db);

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    id: row.id as string,
    email: row.email as string,
    hookToken: row.hook_token as string,
    pro: row.pro as number,
    stripeCustomerId: (row.stripe_customer_id as string | null) ?? null,
  };
}

export const accounts = {
  upsertByEmail(email: string): Account {
    const existing = db
      .prepare("SELECT * FROM accounts WHERE email = ?")
      .get(email) as Record<string, unknown> | undefined;
    if (existing) return rowToAccount(existing);

    const account: Account = {
      id: nanoid(),
      email,
      hookToken: nanoid(32),
      pro: 0,
      stripeCustomerId: null,
    };
    db.prepare(
      `INSERT INTO accounts (id, email, hook_token, pro, stripe_customer_id, created_at)
       VALUES (?, ?, ?, 0, NULL, ?)`,
    ).run(account.id, account.email, account.hookToken, Date.now());
    return account;
  },

  byHookToken(token: string): Account | undefined {
    const row = db
      .prepare("SELECT * FROM accounts WHERE hook_token = ?")
      .get(token) as Record<string, unknown> | undefined;
    return row ? rowToAccount(row) : undefined;
  },

  bySessionToken(token: string): Account | undefined {
    const row = db
      .prepare(
        `SELECT a.* FROM accounts a
         JOIN sessions s ON s.account_id = a.id
         WHERE s.token = ?`,
      )
      .get(token) as Record<string, unknown> | undefined;
    return row ? rowToAccount(row) : undefined;
  },

  setPro(accountId: string, pro: boolean, stripeCustomerId?: string): void {
    db.prepare(
      `UPDATE accounts SET pro = ?, stripe_customer_id = COALESCE(?, stripe_customer_id)
       WHERE id = ?`,
    ).run(pro ? 1 : 0, stripeCustomerId ?? null, accountId);
  },

  byStripeCustomer(customerId: string): Account | undefined {
    const row = db
      .prepare("SELECT * FROM accounts WHERE stripe_customer_id = ?")
      .get(customerId) as Record<string, unknown> | undefined;
    return row ? rowToAccount(row) : undefined;
  },
};

export const sessions = {
  create(accountId: string): string {
    const token = nanoid(40);
    db.prepare(
      "INSERT INTO sessions (token, account_id, created_at) VALUES (?, ?, ?)",
    ).run(token, accountId, Date.now());
    return token;
  },
  destroy(token: string): void {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  },
};

export const queue = {
  /** Persist an alert for an offline account, trimming to the configured caps. */
  push(accountId: string, alert: Alert): void {
    db.prepare(
      `INSERT INTO queued_alerts (id, account_id, payload, received_at)
       VALUES (?, ?, ?, ?)`,
    ).run(alert.id, accountId, JSON.stringify(alert), alert.receivedAt);

    const cutoff = Date.now() - config.queue.maxAgeMs;
    db.prepare("DELETE FROM queued_alerts WHERE received_at < ?").run(cutoff);
    db.prepare(
      `DELETE FROM queued_alerts WHERE account_id = ? AND id NOT IN (
         SELECT id FROM queued_alerts WHERE account_id = ?
         ORDER BY received_at DESC LIMIT ?
       )`,
    ).run(accountId, accountId, config.queue.maxPerAccount);
  },

  /** Drain queued alerts in arrival order, deleting as we hand them back. */
  drain(accountId: string): Alert[] {
    const rows = db
      .prepare(
        "SELECT payload FROM queued_alerts WHERE account_id = ? ORDER BY received_at ASC",
      )
      .all(accountId) as Array<{ payload: string }>;
    db.prepare("DELETE FROM queued_alerts WHERE account_id = ?").run(accountId);
    return rows.map((r) => JSON.parse(r.payload) as Alert);
  },
};

export const magicLinks = {
  create(email: string): { pollToken: string; linkToken: string } {
    const pollToken = nanoid(24);
    const linkToken = nanoid(32);
    db.prepare(
      `INSERT INTO magic_links (poll_token, link_token, email, consumed, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    ).run(pollToken, linkToken, email, Date.now());
    return { pollToken, linkToken };
  },
  consumeByLink(linkToken: string): string | undefined {
    const row = db
      .prepare("SELECT * FROM magic_links WHERE link_token = ? AND consumed = 0")
      .get(linkToken) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    db.prepare("UPDATE magic_links SET consumed = 1 WHERE link_token = ?").run(
      linkToken,
    );
    return row.email as string;
  },
  pollStatus(pollToken: string): { consumed: boolean; email: string } | undefined {
    const row = db
      .prepare("SELECT email, consumed FROM magic_links WHERE poll_token = ?")
      .get(pollToken) as { email: string; consumed: number } | undefined;
    return row ? { consumed: row.consumed === 1, email: row.email } : undefined;
  },
};

// `db` is intentionally module-private: callers use the typed helpers above
// (accounts/sessions/queue/magicLinks), never the raw connection.

