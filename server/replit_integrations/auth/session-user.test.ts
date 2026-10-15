import { describe, expect, it, vi } from "vitest";
import { applyRefreshResponseAndPersist, applyTokenResponseToSessionUser } from "./session-user";

const oldRefresh = "synthetic-previous-refresh";
const newRefresh = "synthetic-rotated-refresh";

describe("session token response handling", () => {
  it("does not retain unused access tokens and preserves refresh continuity when rotation omits a replacement", () => {
    const user: Record<string, unknown> = {
      refresh_token: oldRefresh,
      access_token: "synthetic-unused-access",
    };
    applyTokenResponseToSessionUser(user, { claims: () => ({ sub: "synthetic-user", exp: 99 }), refresh_token: undefined });
    expect(user.refresh_token).toBe(oldRefresh);
    expect(user.access_token).toBeUndefined();
    expect(user.expires_at).toBe(99);
    expect(user.claims).toEqual({ sub: "synthetic-user", exp: 99 });
  });

  it("writes a refreshed Passport session before acknowledging success", async () => {
    const user = { claims: { sub: "synthetic-user" }, refresh_token: oldRefresh, access_token: "synthetic-access" };
    const session = { passport: { user: { ...user } } };
    let durable = false;
    const persist = vi.fn((callback: (error?: unknown) => void) => {
      durable = true;
      callback();
    });
    await applyRefreshResponseAndPersist(
      user,
      session,
      { claims: () => ({ sub: "synthetic-user", exp: 101 }), refresh_token: newRefresh },
      persist,
    );
    expect(persist).toHaveBeenCalledOnce();
    expect(durable).toBe(true);
    expect(session.passport.user.refresh_token).toBe(newRefresh);
    expect(session.passport.user.access_token).toBeUndefined();
  });

  it("does not expose storage failure details or report a refreshed session as persisted", async () => {
    const user = { refresh_token: oldRefresh };
    const session = { passport: { user } };
    const persist = vi.fn((callback: (error?: unknown) => void) => callback(new Error("postgres://synthetic:private@db/token")));
    await expect(applyRefreshResponseAndPersist(
      user,
      session,
      { claims: () => ({ sub: "synthetic-user" }), refresh_token: newRefresh },
      persist,
    )).rejects.toThrow("Session storage operation failed");
  });
});
