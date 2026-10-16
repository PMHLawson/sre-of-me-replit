import session, { type SessionData, type Store } from "express-session";
import { isEncryptedRefreshToken, type TokenVault } from "./token-vault";

type StoreUser = Record<string, unknown>;
const storageError = () => new Error("Session storage operation failed");

function cloneSession(value: SessionData): SessionData {
  return JSON.parse(JSON.stringify(value)) as SessionData;
}

function passportUser(value: SessionData): StoreUser | undefined {
  const passportData = (value as SessionData & { passport?: unknown }).passport;
  if (!passportData || typeof passportData !== "object" || Array.isArray(passportData)) return undefined;
  const user = (passportData as { user?: unknown }).user;
  if (user === undefined || user === null) return undefined;
  if (typeof user !== "object" || Array.isArray(user)) throw storageError();
  return user as StoreUser;
}

/**
 * Encrypts only the refresh credential at the persistence boundary.
 * The wrapped NonresurrectingStore remains responsible for insert-once /
 * update-only behavior, so this wrapper cannot re-create a destroyed SID.
 */
export class EncryptedTokenSessionStore extends session.Store {
  constructor(private readonly delegate: Store, private readonly vault: TokenVault) {
    super();
  }

  override get(sid: string, callback: (error: unknown, value?: SessionData | null) => void): void {
    this.delegate.get(sid, (error, stored) => {
      if (error) {
        callback(storageError());
        return;
      }
      if (!stored) {
        callback(null, stored);
        return;
      }
      try {
        const value = cloneSession(stored);
        const user = passportUser(value);
        if (user) {
          const token = user.refresh_token;
          if (isEncryptedRefreshToken(token)) user.refresh_token = this.vault.decrypt(token);
          else if (token !== undefined && token !== null && typeof token !== "string") throw storageError();
          // Access tokens are unused by this app. Do not retain them in memory
          // for sessions being read from the legacy plaintext format.
          delete user.access_token;
        }
        callback(null, value);
      } catch {
        callback(storageError());
      }
    });
  }

  override set(sid: string, value: SessionData, callback?: (error?: unknown) => void): void {
    try {
      const persisted = cloneSession(value);
      const user = passportUser(persisted);
      if (user) {
        const token = user.refresh_token;
        if (typeof token === "string") user.refresh_token = this.vault.encrypt(token);
        else if (isEncryptedRefreshToken(token)) {
          // Re-encrypt under the active key on the next session write.
          user.refresh_token = this.vault.encrypt(this.vault.decrypt(token));
        } else if (token !== undefined && token !== null) {
          throw storageError();
        } else {
          delete user.refresh_token;
        }
        delete user.access_token;
      }
      // Preserve the delegate's synchronous insert-once marker on the live session.
      // The detached value still carries its pre-write marker for the first INSERT.
      value.__srePersisted = true;
      this.delegate.set(sid, persisted, error => callback?.(error ? storageError() : undefined));
    } catch {
      callback?.(storageError());
    }
  }

  override destroy(sid: string, callback?: (error?: unknown) => void): void {
    this.delegate.destroy(sid, error => callback?.(error ? storageError() : undefined));
  }

  override touch(sid: string, value: SessionData, callback?: (error?: unknown) => void): void {
    const touch = this.delegate.touch as unknown as
      ((sid: string, value: SessionData, callback?: (error?: unknown) => void) => void) | undefined;
    if (!touch) {
      callback?.();
      return;
    }
    touch.call(this.delegate, sid, value, error => callback?.(error ? storageError() : undefined));
  }

  close(): void {
    const close = (this.delegate as Store & { close?: () => void }).close;
    close?.call(this.delegate);
  }
}
