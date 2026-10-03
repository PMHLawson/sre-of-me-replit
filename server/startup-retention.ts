/** SOMR-459: preservation is the deliberate startup default. */
export const SESSION_RETENTION_DAYS = 42;
const SESSION_RETENTION_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface RetentionStorage {
  purgeExpiredDeletedSessions(cutoff: Date): Promise<number>;
}

interface StartupRetentionOptions {
  optIn: string | undefined;
  storage: RetentionStorage;
  log: (message: string, source?: string) => void;
  now?: () => number;
  reportError?: (message: string, error: unknown) => void;
}

/**
 * Only SESSION_RETENTION_PURGE_ENABLED=true (exact lowercase literal) enables
 * expiry deletion. No trimming, coercion or other truthy spellings are accepted.
 * The caller intentionally does not await this: opted-in behavior retains the
 * previous cutoff, logging and non-blocking rejection handling.
 */
export function runStartupRetention({
  optIn,
  storage,
  log,
  now = Date.now,
  reportError = (message, error) => console.error(message, error),
}: StartupRetentionOptions): Promise<void> | undefined {
  if (optIn !== "true") return;

  const cutoff = new Date(now() - SESSION_RETENTION_MS);
  return storage
    .purgeExpiredDeletedSessions(cutoff)
    .then((count) => {
      log(
        `purged ${count} soft-deleted session${count === 1 ? "" : "s"} ` +
          `older than ${SESSION_RETENTION_DAYS}d`,
        "retention",
      );
    })
    .catch((err) => {
      reportError("[retention] purgeExpiredDeletedSessions failed:", err);
    });
}