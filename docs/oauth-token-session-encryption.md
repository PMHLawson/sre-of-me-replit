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

New writes use the active key. Reads accept retained old key IDs. On the next session write, a decrypted old-key token is encrypted with the current active key. Rotation is: add a new key while retaining old keys; switch `activeKeyId`; migrate old-key ciphertext in bounded compare-and-swap batches; verify no rows refer to the old ID; retain the old key through the seven-day session TTL and recovery window; only then remove it. Losing a key makes ciphertext under that key unreadable. There is no plaintext fallback.

## Legacy sessions and bounded migration

The reader accepts the existing legacy string value for `refresh_token`, so active users are not immediately logged out. It removes unused `access_token` from the in-memory user. Any subsequent session write encrypts the refresh token and omits the access token. A read alone does not rewrite the persisted row; inactive legacy rows remain unchanged until an explicit migration or ordinary session expiry.

After independent review and owner key provisioning, a separate migration may process at most 100 unexpired rows per transaction. For each row it must:

1. Read only the session ID, expiry and exact stored `sess::text`; do not export token values to logs or receipts.
2. Skip records that are already encrypted; decrypt and validate their key IDs before continuing.
3. For a legacy string refresh token, encrypt it with the active key and remove the unused access token in the replacement JSON.
4. Update only when the same session ID, exact prior `sess::text` and expiry still match. A conflict is skipped and retried from a fresh read; it must never overwrite a concurrent login, refresh or logout.
5. Preserve the session ID, expiry, cookie, Passport claims and all unrelated fields. Never delete, reset or recreate a session.
6. After each bounded batch, verify row counts and ciphertext/key-ID classifications without printing values.

This candidate does not run that migration and does not touch any owner database. The existing seven-day TTL remains unchanged. No forced user logout is needed; rows not touched by the migration expire through the existing behavior.

## Rollback boundary

Once any ciphertext has been written, the pre-candidate plaintext-only application cannot safely read those sessions. A code rollback must therefore retain this ciphertext reader, the exact envelope formats, and every key needed by existing rows. Revert unrelated changes only to a version that continues to read and write encrypted sessions. Do not roll back to the plaintext-only store or remove old keys while ciphertext remains.

If a rollback to plaintext-only code is ever required, it needs a separately reviewed, bounded reverse migration that decrypts with the retained keyring, uses the same compare-and-swap protection, verifies the result, and is explicitly approved despite restoring cleartext at rest. It is not an automatic recovery action and is not included or performed here. If a required key is unavailable, fail closed and recover the key securely or require a deliberate account reauthentication plan; never write plaintext as a fallback.

## Synthetic verification

The candidate tests use only synthetic key bytes, synthetic token markers, and a nonce-marked Unix-socket PostgreSQL fixture. They cover ciphertext-only persistence, legacy reads and encrypted refresh writeback, active/previous key rotation, tamper and unknown/missing-key rejection, sanitized failures, omission of unused access tokens, token-free synthetic user responses, logout and the existing nonresurrecting session-write behavior. No provider is contacted and no owner database, key, token, workflow or live session is used.
