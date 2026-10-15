export interface TokenResponseForSession {
  claims(): unknown;
  refresh_token?: unknown;
}

export type PersistSession = (callback: (error?: unknown) => void) => void;

/** Keep only claims, expiry, and the refresh credential required for renewal. */
export function applyTokenResponseToSessionUser(
  user: Record<string, unknown>,
  tokens: TokenResponseForSession,
): void {
  const claimsValue = tokens.claims();
  const claims = claimsValue && typeof claimsValue === "object"
    ? claimsValue as Record<string, unknown>
    : undefined;
  user.claims = claimsValue;
  if (typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0) {
    user.refresh_token = tokens.refresh_token;
  } else if (typeof user.refresh_token !== "string" || user.refresh_token.length === 0) {
    delete user.refresh_token;
  }
  user.expires_at = claims?.exp;
  // The application never consumes access_token; it is transient only.
  delete user.access_token;
}

/**
 * Apply a refresh result to the authenticated user and durably save the same
 * user through the installed Express session middleware before the request
 * continues. All storage failures are deliberately sanitized.
 */
export async function applyRefreshResponseAndPersist(
  user: Record<string, unknown>,
  session: unknown,
  tokens: TokenResponseForSession,
  persist: PersistSession,
): Promise<void> {
  applyTokenResponseToSessionUser(user, tokens);
  const sessionRecord = session && typeof session === "object"
    ? session as Record<string, unknown>
    : undefined;
  const passportData = sessionRecord?.passport;
  const storedUser = passportData && typeof passportData === "object" && !Array.isArray(passportData)
    ? (passportData as Record<string, unknown>).user
    : undefined;
  if (!storedUser || typeof storedUser !== "object" || Array.isArray(storedUser)) {
    throw new Error("Session storage operation failed");
  }
  if (storedUser !== user) {
    const target = storedUser as Record<string, unknown>;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, user);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      persist(error => error ? reject(new Error("Session storage operation failed")) : resolve());
    });
  } catch {
    throw new Error("Session storage operation failed");
  }
}
