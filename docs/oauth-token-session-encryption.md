# OAuth refresh-token protection in application sessions

## Candidate scope

This isolated candidate protects the Replit OIDC refresh credential when Express serializes a Passport user into `http_sessions`. It does not change provider configuration, the session-signing secret, the session cookie, logout, persistence ownership rules, or the database schema.

The application refreshes expired credentials with `refresh_token`; no application code consumes the OIDC `access_token`. New and rewritten session records therefore retain only the refresh token, encrypted, plus the existing claims and expiry data. The access token is not copied into the session user. The refresh token is decrypted only after the session store reads it and is available in process memory to the refresh flow. The `/api/auth/user` route continues to return the application user record, not the Passport token object.

## Dedicated keyring configuration

The candidate reads only the server-side Replit Secret named `OAUTH_TOKEN_ENCRYPTION_KEYRING`. It is independent of `SESSION_SECRET`; the session-signing secret is never used as encryption material. The accepted format is a JSON object:

```json
{
  "activeKeyId": "key-a",
  "keys": {
    "key-a": "<base64url-encoded 32-byte key>"
  }
}
```

Key IDs are limited to 1–32 ASCII letters, digits, `_` or `-`. The keyring permits at most eight keys; every key must decode canonically to exactly 32 bytes. Invalid JSON, a missing active key, malformed or missing material, and unsupported envelope data fail closed with sanitized errors. The code never substitutes another secret, logs key material, or returns it through a route.

The Development secret-existence check for this required name returned **false**. No real key was generated, requested, set, rotated, or copied. This candidate is not ready to activate until the owner provisions the dedicated keyring after source review. Missing configuration prevents session middleware construction rather than falling back to plaintext writes.

## Stored envelope and rotation

Refresh tokens use Node's `aes-256-gcm` with a fresh 12-byte nonce, 16-byte authentication tag, and associated data binding the application purpose, envelope version and key ID. The JSON envelope contains only the algorithm, version, key ID, nonce, tag and ciphertext. It is authenticated before any token is returned. Tampering, an unknown key ID, an invalid encoding or a bad tag rejects session loading with `Session storage operation failed`; crypto-library errors and token values are not logged.

New writes use the active key. Reads accept retained old key IDs. On the next session write, a decrypted old-key token is encrypted with the current active key. Rotation is: add a new key while retaining old keys; switch `activeKeyId`; migrate old-key ciphertext in bounded compare-and-swap batches; verify no rows refer to the old ID; retain old decrypt keys for every applicable retained database backup and recovery copy; only remove a key after proving that no live or recoverable ciphertext still needs it. Seven-day HTTP-session expiry alone is insufficient. Losing a key makes ciphertext under that key unreadable. There is no plaintext fallback.

## Legacy sessions and bounded migration

The reader accepts the existing legacy string value for `refresh_token`, so active users are not immediately logged out. It removes unused `access_token` from the in-memory user. Any subsequent session write encrypts the refresh token and omits the access token. A read alone does not rewrite the persisted row; inactive legacy rows remain unchanged until an explicit migration or ordinary session expiry.

The internal module `migrate-session-tokens.ts` supplies an explicitly invoked, bounded migration. It is not imported by a route or startup path and has no automatic loop. Its default is a read-only dry run. It accepts an injected pool and validated `TokenVault`; source verification uses only a disposable synthetic database and synthetic keys, before owner key provisioning.

Each invocation reads at most 100 rows, including expired retained rows. Expiry of an HTTP session does not revoke a stored provider refresh token. It validates current ciphertext, rewraps old-key ciphertext, encrypts legacy strings, and removes unused access tokens even if the refresh token is already encrypted or absent. Unknown keys, malformed session/token data and database failures stop the batch with a sanitized error. A later invalid row rolls back earlier updates in the same transaction.

The update changes only the two credential paths through PostgreSQL JSONB operations. It preserves session IDs, exact database expiry, cookies, claims, persistence markers and unrelated values, including numbers beyond JavaScript's exact integer range. Its UPDATE must match the exact prior session ID, `sess::text` and `expire::text`. Concurrent refresh, touch, expiry change or logout therefore causes a conflict rather than overwriting the new state or recreating a deleted row. Statement and lock waits are bounded.

The result separates aggregate counts from a sensitive internal pagination cursor. Log only `result.counts`; never log, export or publish the whole result, cursor, session IDs, session JSON, tokens or keys. A cursor is for private in-process use only. Conflicts require a fresh read. A live operator packet must specify a bounded retry allowance and stop for investigation if conflicts do not settle; this module does not retry automatically.

Before any live apply:
1. Preserve a fresh private database recovery copy and the exact source checkpoint. Prove that the rollback source can read ciphertext and that required decrypt keys can be recovered securely.
2. Ensure every application writer uses the protected session codec; an old writer can otherwise reintroduce plaintext after a scan.
3. Inventory all retained rows using dry-run batches and private cursors, without printing credential contents. Review aggregate counts, including expired records.
4. Apply bounded batches, then repeat a complete fresh inventory. Completion requires no remaining plaintext/access-token removals, no unresolved conflicts, and valid ciphertext under retained keys. Do not treat a partial page or an HTTP-session expiry as completion.

No owner database was inventoried or migrated, no key was provisioned, and no real session was changed by source verification. Live apply and activation remain held. The existing session TTL is unchanged; this operation never deletes, resets or recreates a session.

## Rollback boundary

Once any ciphertext has been written, the pre-candidate plaintext-only application cannot safely read those sessions. A code rollback must therefore retain this ciphertext reader, the exact envelope formats, and every key needed by existing rows. Revert unrelated changes only to a version that continues to read and write encrypted sessions. Do not roll back to the plaintext-only store or remove old keys while ciphertext remains.

If a rollback to plaintext-only code is ever required, it needs a separately reviewed, bounded reverse migration that decrypts with the retained keyring, uses the same compare-and-swap protection, verifies the result, and is explicitly approved despite restoring cleartext at rest. It is not an automatic recovery action and is not included or performed here. If a required key is unavailable, fail closed and recover the key securely or require a deliberate account reauthentication plan; never write plaintext as a fallback.

## Synthetic verification

The candidate tests use only synthetic key bytes, synthetic token markers, and a nonce-marked Unix-socket PostgreSQL fixture. They cover ciphertext-only persistence, legacy reads and encrypted refresh writeback, active/previous key rotation, tamper and unknown/missing-key rejection, sanitized failures, omission of unused access tokens, token-free synthetic user responses, logout and the existing nonresurrecting session-write behavior. No provider is contacted and no owner database, key, token, workflow or live session is used.
