/** SOMR-469: retain historical data regardless of age or reporting window. */
interface RetentionStorage {
  purgeExpiredDeletedSessions(cutoff: Date): Promise<number>;
}

interface StartupRetentionOptions {
  /** Retired environment flag: accepted only to report an obsolete setting. */
  optIn: string | undefined;
  log: (message: string, source?: string) => void;
  /** Deprecated compatibility dependencies. They are never accessed or called. */
  storage?: RetentionStorage;
  now?: () => number;
  reportError?: (message: string, error: unknown) => void;
}

/**
 * Automatic age-based deletion is retired. Even the former exact opt-in cannot
 * run maintenance, open storage, inspect records or calculate an expiry cutoff.
 * Soft deletion/restoration remain separate authenticated user actions.
 */
export function runStartupRetention({
  optIn,
  log,
}: StartupRetentionOptions): undefined {
  if (optIn === "true") {
    log(
      "SESSION_RETENTION_PURGE_ENABLED is retired and ignored; historical data is preserved.",
      "retention",
    );
  }
  return undefined;
}
