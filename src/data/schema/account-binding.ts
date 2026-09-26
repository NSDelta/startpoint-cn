import { Database } from "better-sqlite3"
import { getRealNow } from "../../runtime/time/game-time"

/**
 * Creates the account binding tables defined by contract C2.
 *
 * The tables must be created after `accounts` exists, because every child
 * table references it.
 */
export function initializeAccountBindingSchemaSync(database: Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS signup_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'bound', 'expired', 'revoked')),
            platform TEXT CHECK (platform IN ('qq', 'kook')),
            platform_uid TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
        )
    `)
    database.exec(`
        CREATE INDEX IF NOT EXISTS idx_signup_codes_account_status
        ON signup_codes (account_id, status, expires_at)
    `)

    database.exec(`
        CREATE TABLE IF NOT EXISTS account_bindings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            platform TEXT NOT NULL CHECK (platform IN ('qq', 'kook')),
            platform_uid TEXT NOT NULL,
            display_name TEXT,
            is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
            created_by TEXT NOT NULL CHECK (created_by IN ('bot', 'admin', 'migration')),
            note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
        )
    `)
    database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_account_bindings_primary
        ON account_bindings (platform, platform_uid) WHERE is_primary = 1
    `)
    database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_account_bindings_triple
        ON account_bindings (platform, platform_uid, account_id)
    `)
    database.exec(`
        CREATE INDEX IF NOT EXISTS idx_account_bindings_account
        ON account_bindings (account_id, platform, is_primary DESC, id DESC)
    `)

    database.exec(`
        CREATE TABLE IF NOT EXISTS device_grants (
            device_id INTEGER PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            token TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    `)
    database.exec(`
        CREATE INDEX IF NOT EXISTS idx_device_grants_account
        ON device_grants (account_id)
    `)

    database.exec(`
        CREATE TABLE IF NOT EXISTS bind_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            account_id INTEGER,
            platform TEXT,
            platform_uid TEXT,
            detail TEXT,
            actor TEXT,
            created_at TEXT NOT NULL
        )
    `)
    database.exec(`
        CREATE INDEX IF NOT EXISTS idx_bind_audit_account
        ON bind_audit (account_id, created_at DESC, id DESC)
    `)
}

/**
 * Data migration for databases created before contract C2 (schema 29).
 *
 * Table creation and the three new `accounts` columns are handled on every
 * startup by the initializer, so this migration only normalizes rows that
 * already exist when an old database is opened by this build.
 */
export function migrateAccountBindingSchema29Sync(
    database: Database,
    currentVersion: number,
): void {
    if (currentVersion > 28) return

    const now = getRealNow().toISOString()

    // Accounts created by the legacy signup endpoint predate the binding gate;
    // they must not be locked out by it.
    database.prepare(`
        UPDATE accounts
        SET bind_state = 'active'
        WHERE bind_state IS NULL OR bind_state = ''
    `).run()

    // A pending code that outlived its TTL must not stay consumable.
    database.prepare(`
        UPDATE signup_codes
        SET status = 'expired', updated_at = ?, revision = revision + 1
        WHERE status = 'pending' AND expires_at <= ?
    `).run(now, now)
}
