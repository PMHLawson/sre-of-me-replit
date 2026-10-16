import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../../lib/ownership-fixture";
import { migrateSessionTokenBatch } from "./migrate-session-tokens";
import { createTokenVault, isEncryptedRefreshToken } from "./token-vault";

const SAFE_ERROR = "Session token migration unavailable";
const TOKEN = "synthetic-legacy-refresh";
const ACCESS = "synthetic-unused-access";
const FUTURE = "2099-01-02 03:04:05.123456";
const PAST = "2000-01-02 03:04:05.654321";
const activeKey = Buffer.alloc(32, 0x61), oldKey = Buffer.alloc(32, 0x32);
const vault = createTokenVault({ activeKeyId: "active", keys: { active: activeKey, old: oldKey } });
const oldVault = createTokenVault({ activeKeyId: "old", keys: { old: oldKey } });
const unknownVault = createTokenVault({ activeKeyId: "unknown", keys: { unknown: Buffer.alloc(32, 0x7a) } });
type MigrationPool = Parameters<typeof migrateSessionTokenBatch>[0];
type MigrationOptions = Parameters<typeof migrateSessionTokenBatch>[2];
let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
let pool: Pool;

function sessionValue(refresh: unknown = TOKEN) {
  const user: Record<string, unknown> = {
    claims: { sub: "synthetic-user", exp: 4_070_908_800 }, expires_at: 4_070_908_800,
    refresh_token: refresh, access_token: ACCESS,
  };
  return {
    cookie: { originalMaxAge: 60_000, expires: "2099-01-02T03:04:05.123Z", secure: true,
      httpOnly: true, sameSite: "lax", path: "/" },
    passport: { user }, __srePersisted: true, unrelated: { retained: ["synthetic", 17, null] },
  };
}
async function put(sid: string, value: unknown, expiry = FUTURE) {
  await pool.query("INSERT INTO public.http_sessions(sid,sess,expire) VALUES($1,$2::jsonb,$3::timestamp)",
    [sid, typeof value === "string" ? value : JSON.stringify(value), expiry]);
}
async function snapshot() {
  return (await pool.query('SELECT sid,sess::text AS sess,expire::text AS expire FROM public.http_sessions ORDER BY sid COLLATE "C"')).rows;
}
async function stored(sid: string) {
  const result = await pool.query("SELECT sess FROM public.http_sessions WHERE sid=$1", [sid]);
  expect(result.rowCount).toBe(1);
  return result.rows[0].sess as Record<string, any>;
}
function assertEncrypted(value: unknown, expected: string) {
  expect(isEncryptedRefreshToken(value)).toBe(true);
  if (!isEncryptedRefreshToken(value)) throw Error("Missing synthetic envelope");
  expect(value.keyId).toBe("active");
  expect(vault.decrypt(value)).toBe(expected);
}
/** Changes only the test's owned connection, after snapshot and before CAS. */
function instrument(options: { afterRead?: () => Promise<void>; failUpdate?: boolean } = {}) {
  const proof = { connects: 0, releases: 0, reads: 0, updates: 0, statements: [] as string[] };
  const database: MigrationPool = {
    async connect() {
      proof.connects++;
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          proof.statements.push(sql);
          if (/^\s*UPDATE\b/i.test(sql)) {
            proof.updates++;
            if (options.failUpdate) throw Error("synthetic-database-private-error");
          }
          const result = await client.query(sql, values);
          if (/\bprior_sess\b/i.test(sql) && /\bFROM\b/i.test(sql)) {
            proof.reads++;
            if (options.afterRead) await options.afterRead();
          }
          return result;
        },
        release() { proof.releases++; client.release(); },
      };
    },
  };
  return { database, proof };
}
beforeAll(async () => {
  for (const name of ["DATABASE_URL", "SESSION_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEYRING"]) {
    if (process.env[name]) throw Error("Synthetic fixture must not inherit owner bindings");
  }
  fixture = await startFixture("somr474-session-token-migration");
  verifyFixture(fixture.root);
  pool = new Pool({
    host: `${fixture.root}/socket`, port: 5432, user: "synthetic", database: "postgres",
    password: "", ssl: false, connectionTimeoutMillis: 5000,
    options: "-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=2000",
  });
  await pool.query("CREATE TABLE IF NOT EXISTS public.http_sessions(sid varchar PRIMARY KEY,sess jsonb NOT NULL,expire timestamp(6) NOT NULL)");
}, 60_000);
beforeEach(async () => {
  verifyFixture(fixture!.root);
  await pool.query("TRUNCATE public.http_sessions");
});
afterAll(async () => {
  try { if (pool) await pool.end(); }
  finally { if (fixture) { verifyFixture(fixture.root); await fixture.cleanup(); } }
}, 60_000);

describe("bounded session-token migration on synthetic PostgreSQL", () => {
  it("defaults to a read-only dry run without changing rows", async () => {
    await put("dry-run", sessionValue());
    const before = await snapshot(), { database, proof } = instrument();
    const result = await migrateSessionTokenBatch(database, vault);
    expect(result.counts).toEqual({ scanned: 1, wouldChange: 1, updated: 0, conflicts: 0, unchanged: 0, expired: 0 });
    expect(result.privateNextCursor).toBeNull();
    expect(await snapshot()).toEqual(before);
    expect(proof.updates).toBe(0);
    expect(proof.connects).toBe(1);
    expect(proof.releases).toBe(1);
    expect(proof.statements.some(sql => /^\s*ROLLBACK\s*$/i.test(sql))).toBe(true);
  });
  it("handles expired, access-only, current and previous-key rows idempotently", async () => {
    const accessOnly = sessionValue(); delete accessOnly.passport.user.refresh_token;
    const currentWithAccess = sessionValue(vault.encrypt("synthetic-current"));
    const previousKey = sessionValue(oldVault.encrypt("synthetic-old")); delete previousKey.passport.user.access_token;
    const currentClean = sessionValue(vault.encrypt("synthetic-clean")); delete currentClean.passport.user.access_token;
    await put("a-expired", sessionValue(), PAST); await put("b-access-only", accessOnly);
    await put("c-current-access", currentWithAccess); await put("d-previous-key", previousKey);
    await put("e-current-clean", currentClean);
    await put("f-anonymous", { cookie: sessionValue().cookie, challenge: "synthetic-oidc-state" });
    const before = await snapshot();
    const first = await migrateSessionTokenBatch(pool, vault, { apply: true });
    expect(first.counts).toEqual({ scanned: 6, wouldChange: 4, updated: 4, conflicts: 0, unchanged: 2, expired: 1 });
    const after = await snapshot();
    expect(after.map(row => [row.sid, row.expire])).toEqual(before.map(row => [row.sid, row.expire]));
    assertEncrypted((await stored("a-expired")).passport.user.refresh_token, TOKEN);
    expect((await stored("b-access-only")).passport.user).not.toHaveProperty("refresh_token");
    assertEncrypted((await stored("c-current-access")).passport.user.refresh_token, "synthetic-current");
    assertEncrypted((await stored("d-previous-key")).passport.user.refresh_token, "synthetic-old");
    for (const sid of ["a-expired", "b-access-only", "c-current-access", "d-previous-key"])
      expect((await stored(sid)).passport.user).not.toHaveProperty("access_token");
    for (const sid of ["e-current-clean", "f-anonymous"])
      expect(after.find(row => row.sid === sid)).toEqual(before.find(row => row.sid === sid));
    const second = await migrateSessionTokenBatch(pool, vault, { apply: true });
    expect(second.counts).toEqual({ scanned: 6, wouldChange: 0, updated: 0, conflicts: 0, unchanged: 6, expired: 1 });
    expect(await snapshot()).toEqual(after);
  });
  it("resumes keyset pagination across bounded batches", async () => {
    for (const sid of ["01", "02", "03", "04", "05"]) await put(sid, sessionValue(`synthetic-${sid}`));
    const first = await migrateSessionTokenBatch(pool, vault, { limit: 2, apply: true });
    expect(first.counts.scanned).toBe(2); expect(first.counts.updated).toBe(2); expect(first.privateNextCursor).toBe("02");
    const second = await migrateSessionTokenBatch(pool, vault, { after: first.privateNextCursor!, limit: 2, apply: true });
    expect(second.counts.scanned).toBe(2); expect(second.counts.updated).toBe(2); expect(second.privateNextCursor).toBe("04");
    const third = await migrateSessionTokenBatch(pool, vault, { after: second.privateNextCursor!, limit: 2, apply: true });
    expect(third.counts.scanned).toBe(1); expect(third.counts.updated).toBe(1); expect(third.privateNextCursor).toBeNull();
    for (const sid of ["01", "02", "03", "04", "05"]) assertEncrypted((await stored(sid)).passport.user.refresh_token, `synthetic-${sid}`);
  });
  it("preserves unrelated JSON numeric precision and database microseconds", async () => {
    const literal = `{
      "cookie":{"expires":"2099-01-02T03:04:05.123Z"},"__srePersisted":true,
      "passport":{"user":{"claims":{"sub":"synthetic-precision","large":9007199254740993.123456789123456789},
        "refresh_token":"${TOKEN}","access_token":"${ACCESS}"}},
      "unrelated":{"large":9007199254740993.123456789123456789}
    }`;
    await put("precision", literal);
    const preserved = async () => (await pool.query(`
      SELECT ((sess #- '{passport,user,refresh_token}') #- '{passport,user,access_token}')::text AS other,
        expire::text AS expire FROM public.http_sessions WHERE sid='precision'
    `)).rows[0];
    const before = await preserved();
    expect(before.other).toContain("9007199254740993.123456789123456789");
    expect(before.expire).toContain(".123456");
    await migrateSessionTokenBatch(pool, vault, { apply: true });
    expect(await preserved()).toEqual(before);
    assertEncrypted((await stored("precision")).passport.user.refresh_token, TOKEN);
  });
  it.each([
    ["malformed", { format: "sre-oauth-refresh-token", version: 999 }],
    ["unknown-key", unknownVault.encrypt("synthetic-unknown-key-token")],
  ])("never commits a partial batch containing %s", async (_name, badToken) => {
    await put("a-valid-first", sessionValue()); await put("b-blocked", sessionValue(badToken));
    const before = await snapshot(), { database, proof } = instrument();
    await expect(migrateSessionTokenBatch(database, vault, { apply: true })).rejects.toThrow(SAFE_ERROR);
    expect(await snapshot()).toEqual(before); expect(proof.releases).toBe(1);
    expect(proof.statements.some(sql => /^\s*ROLLBACK\s*$/i.test(sql))).toBe(true);
  });
  it.each(["refresh", "touch", "delete"] as const)("does not overwrite a concurrent %s", async action => {
    await put("concurrent", sessionValue());
    let concurrentState: Awaited<ReturnType<typeof snapshot>> | undefined, fired = false;
    const { database, proof } = instrument({
      afterRead: async () => {
        if (fired) throw Error("Unexpected second migration snapshot"); fired = true;
        if (action === "refresh") {
          const replacement = sessionValue(vault.encrypt("synthetic-concurrent-refresh")); delete replacement.passport.user.access_token;
          await pool.query("UPDATE public.http_sessions SET sess=$2::jsonb WHERE sid=$1", ["concurrent", JSON.stringify(replacement)]);
        } else if (action === "touch") {
          await pool.query("UPDATE public.http_sessions SET expire=expire+interval '1 minute' WHERE sid=$1", ["concurrent"]);
        } else await pool.query("DELETE FROM public.http_sessions WHERE sid=$1", ["concurrent"]);
        concurrentState = await snapshot();
      },
    });
    const result = await migrateSessionTokenBatch(database, vault, { apply: true });
    expect(fired).toBe(true); expect(proof.reads).toBe(1);
    expect(result.counts).toEqual({ scanned: 1, wouldChange: 1, updated: 0, conflicts: 1, unchanged: 0, expired: 0 });
    expect(await snapshot()).toEqual(concurrentState); expect(proof.releases).toBe(1);
    if (action === "delete") expect(await snapshot()).toEqual([]);
  });
  it.each([
    { limit: 0 }, { limit: 101 }, { limit: -1 }, { limit: 1.5 }, { limit: Number.NaN },
    { limit: Number.POSITIVE_INFINITY }, { limit: "2" }, { after: 17 }, { after: "x".repeat(513) },
    { after: "synthetic" + String.fromCharCode(0) + "cursor" }, { apply: "yes" }, { unexpected: true },
  ])("rejects invalid options before connecting: %#", async options => {
    const connect = vi.fn(async () => { throw Error("Invalid input must not acquire a database connection"); });
    await expect(migrateSessionTokenBatch({ connect }, vault, options as unknown as MigrationOptions)).rejects.toThrow(SAFE_ERROR);
    expect(connect).not.toHaveBeenCalled();
  });
  it("releases its connection after commit", async () => {
    await put("release-success", sessionValue()); const { database, proof } = instrument();
    await migrateSessionTokenBatch(database, vault, { apply: true });
    expect(proof.connects).toBe(1); expect(proof.releases).toBe(1);
    expect(proof.statements.some(sql => /^\s*COMMIT\s*$/i.test(sql))).toBe(true);
    expect(pool.waitingCount).toBe(0);
  });
  it("rolls back and releases after a sanitized database failure", async () => {
    await put("release-error", sessionValue()); const before = await snapshot(), { database, proof } = instrument({ failUpdate: true });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(migrateSessionTokenBatch(database, vault, { apply: true })).rejects.toThrow(SAFE_ERROR);
      expect(await snapshot()).toEqual(before); expect(proof.updates).toBe(1); expect(proof.releases).toBe(1);
      expect(proof.statements.some(sql => /^\s*ROLLBACK\s*$/i.test(sql))).toBe(true); expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
