/**
 * Credential hashing for `accounts.password_hash` — contract C1.
 *
 * There is deliberately exactly ONE implementation. The hash is written by two
 * very different callers:
 *
 *   - `POST /sp-auth/register` (the tweak's own sign-up), and
 *   - `POST /api/server/accounts/:id/password` (the admin panel resetting a
 *     password by hand).
 *
 * A second helper that drifted in algorithm or cost factor would not fail
 * loudly: it would silently lock the account out of `POST /sp-auth/login`
 * (`bcrypt.compareSync` just returns false). Cost 10 is therefore frozen here
 * and shared, which is also why the cost factor is a named constant instead of
 * a literal at each call site.
 *
 * Field *rules* (what may become a password) live in `./contract.ts`.
 */

import bcrypt from "bcryptjs"

/**
 * bcrypt cost factor. Every row already in production was written with 10, so
 * changing this does not re-hash anything — it only makes new hashes
 * incompatible with nothing. Leave it alone unless a migration is written.
 */
export const PASSWORD_HASH_ROUNDS = 10

export function hashPassword(password: string): string {
    return bcrypt.hashSync(password, PASSWORD_HASH_ROUNDS)
}

/**
 * Fail-closed comparison against a stored hash.
 *
 * A missing or malformed `password_hash` must never turn into a 500 on the
 * login page (or into an accidental match): `null`, `""` and garbage all mean
 * "no".
 */
export function verifyPasswordHash(password: string, hash: string | null | undefined): boolean {
    if (typeof hash !== "string" || hash.length === 0) return false
    try {
        return bcrypt.compareSync(password, hash)
    } catch {
        return false
    }
}
