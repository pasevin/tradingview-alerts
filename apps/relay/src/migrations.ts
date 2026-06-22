/**
 * Schema migration system for the relay's SQLite database.
 *
 * Tracks a single integer `schema_version` in a `_meta` table. On startup,
 * runs any pending migrations in order. Each migration is idempotent — safe
 * to re-run if it was already applied (the version gate prevents this, but
 * the migrations themselves use ADD COLUMN IF NOT EXISTS patterns).
 *
 * To add a new migration:
 *   1. Add a new function `migrate_vN_to_vN1(db)`
 *   2. Register it in the MIGRATIONS array
 *   3. Bump TARGET_VERSION
 *
 * NEVER modify an existing migration — add a new one. Existing production
 * databases may have already applied it.
 */
import type Database from "better-sqlite3";

export const TARGET_VERSION = 2;

type MigrationFn = (db: Database.Database) => void;

interface Migration {
  version: number;
  description: string;
  up: MigrationFn;
}

/**
 * v0 → v1: Initial schema.
 * Creates all tables if they don't exist. This covers fresh databases
 * and legacy databases that were created before the migration system.
 */
const migrate_v0_to_v1: MigrationFn = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                TEXT PRIMARY KEY,
      email             TEXT UNIQUE NOT NULL,
      hook_token        TEXT UNIQUE NOT NULL,
      pro               INTEGER NOT NULL DEFAULT 0,
      stripe_customer_id TEXT,
      created_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      poll_token TEXT PRIMARY KEY,
      link_token TEXT UNIQUE NOT NULL,
      email      TEXT NOT NULL,
      consumed   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queued_alerts (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES accounts(id),
      payload     TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );
  `);
};

/**
 * v1 → v2: Add received_at column to queued_alerts.
 * Legacy databases created before the migration system may have
 * queued_alerts without the received_at column. Also creates the
 * queue index.
 */
const migrate_v1_to_v2: MigrationFn = (db) => {
  const cols = db.prepare("PRAGMA table_info(queued_alerts)").all() as Array<{ name: string }>;
  const hasReceivedAt = cols.some((c) => c.name === "received_at");
  if (!hasReceivedAt) {
    db.exec("ALTER TABLE queued_alerts ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_queue_account ON queued_alerts(account_id, received_at);");
};

const MIGRATIONS: Migration[] = [
  { version: 1, description: "Initial schema", up: migrate_v0_to_v1 },
  { version: 2, description: "Add received_at to queued_alerts", up: migrate_v1_to_v2 },
];

/**
 * Run all pending migrations. Called once on startup before any queries.
 * Safe to call on a fresh DB (creates everything) or an existing DB
 * (skips already-applied migrations).
 */
export function runMigrations(db: Database.Database): void {
  // Ensure the _meta table exists for tracking schema version
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion >= TARGET_VERSION) {
    return; // Already up to date
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)").run(
        String(migration.version),
      );
    });
    tx();

    console.log(`[db] migration v${migration.version}: ${migration.description}`);
  }
}
