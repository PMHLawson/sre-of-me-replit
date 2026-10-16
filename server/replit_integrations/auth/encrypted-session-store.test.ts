import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import session from "express-session";
import { Passport } from "passport";
import { Pool } from "pg";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { startFixture, verifyFixture } from "../../lib/ownership-fixture";
import { NonresurrectingStore } from "./nonresurrecting-store";
import { EncryptedTokenSessionStore } from "./encrypted-session-store";
import { createTokenVault, isEncryptedRefreshToken } from "./token-vault";
import { applyRefreshResponseAndPersist } from "./session-user";

const require = createRequire(import.meta.url);
const signature = require("cookie-signature") as { sign(value: string, secret: string): string };
const sessionSigningSecret = "synthetic-session-signing-secret";
const legacyRefresh = "synthetic-legacy-refresh-value";
const legacyAccess = "synthetic-unused-access-value";
const rotatedRefresh = "synthetic-rotated-refresh-value";
const oldKey = Buffer.alloc(32, 0x19);
const activeKey = Buffer.alloc(32, 0x73);
const oldVault = createTokenVault({ activeKeyId: "old", keys: { old: oldKey } });
const vault = createTokenVault({ activeKeyId: "active", keys: { old: oldKey, active: activeKey } });

let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
let pool: Pool | undefined;
let store: EncryptedTokenSessionStore | undefined;
let server: http.Server | undefined;
let port = 0;
let leaseDirectory = "";
let temporaryEvidenceDirectory = "";
let fixtureNonce = "";
let observedRefresh: unknown;
let observedAccess: unknown;

const request = (route: string, method = "GET", cookie?: string) => new Promise<{
  status: number;
  body: string;
  cookie?: string;
}>( (resolve, reject) => {
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: route,
    method,
    headers: {
      Host: "synthetic.local",
      "X-Forwarded-Proto": "https",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; });
    response.on("end", () => resolve({
      status: response.statusCode!,
      body,
      cookie: response.headers["set-cookie"]?.[0]?.split(";")[0],
    }));
  });
  req.on("error", reject);
  req.end();
});

const sessionId = (cookie: string) => {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1));
  if (!value.startsWith("s:")) throw new Error("synthetic session cookie format mismatch");
  const signed = value.slice(2);
  const separator = signed.lastIndexOf(".");
  if (separator < 1) throw new Error("synthetic session cookie signature missing");
  return signed.slice(0, separator);
};

const storedSession = async (sid: string): Promise<any> => {
  const result = await pool!.query("SELECT sess FROM http_sessions WHERE sid=$1", [sid]);
  if (result.rowCount !== 1) throw new Error("synthetic session row missing");
  return typeof result.rows[0].sess === "string" ? JSON.parse(result.rows[0].sess) : result.rows[0].sess;
};

const signedCookie = (sid: string) => `connect.sid=${encodeURIComponent(`s:${signature.sign(sid, sessionSigningSecret)}`)}`;

describe("encrypted OAuth token session persistence on a disposable synthetic database", () => {
  beforeAll(async () => {
    if (process.env.DATABASE_URL || process.env.SESSION_SECRET || process.env.OAUTH_TOKEN_ENCRYPTION_KEYRING) {
      throw new Error("fixture must run without owner database or owner secrets");
    }
    const evidenceBase = process.env.OWNERSHIP_EVIDENCE_DIR;
    if (evidenceBase) {
      if (!path.isAbsolute(evidenceBase) || !fs.statSync(evidenceBase).isDirectory()) {
        throw new Error("private fixture evidence directory is invalid");
      }
    } else {
      temporaryEvidenceDirectory = fs.mkdtempSync("/tmp/somr474-token-evidence-");
      fs.chmodSync(temporaryEvidenceDirectory, 0o700);
    }
    const base = evidenceBase || temporaryEvidenceDirectory;
    leaseDirectory = fs.mkdtempSync(path.join(base, "somr474-owned-fixture-"));
    fs.chmodSync(leaseDirectory, 0o700);
    fixtureNonce = crypto.randomUUID();
    fs.writeFileSync(path.join(leaseDirectory, ".ownership"), `somr474:${fixtureNonce}`, { mode: 0o600 });
    fs.writeFileSync(path.join(leaseDirectory, "run.json"), JSON.stringify({
      nonce: fixtureNonce,
      startedAt: new Date().toISOString(),
      candidateBase: "826eb62efa45dcd05267ab42942a99d8b1aa1e45",
      ownerDatabaseUsed: false,
      ownerSecretsUsed: false,
      fixture: "synthetic Unix-socket PostgreSQL only",
    }, null, 2), { mode: 0o600 });

    fixture = await startFixture("somr474-encrypted-session");
    fs.writeFileSync(path.join(fixture.root, "somr474-owner.json"), JSON.stringify({
      nonce: fixtureNonce,
      purpose: "synthetic token-encryption regression fixture",
    }), { mode: 0o600 });
    verifyFixture(fixture.root);
    pool = new Pool({
      host: `${fixture.root}/socket`,
      port: 5432,
      user: "synthetic",
      database: "postgres",
      password: "",
      ssl: false,
      connectionTimeoutMillis: 5000,
      options: "-c statement_timeout=10000 -c lock_timeout=2000",
    });
    store = new EncryptedTokenSessionStore(
      new NonresurrectingStore(pool),
      vault,
    );
    const app = express();
    const passport = new Passport();
    app.set("trust proxy", 1);
    app.use(session({
      secret: sessionSigningSecret,
      store,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: true, sameSite: "lax", maxAge: 60_000 },
    }));
    passport.serializeUser((user, callback) => callback(null, user));
    passport.deserializeUser((user, callback) => callback(null, user as Express.User));
    app.use(passport.initialize());
    app.use(passport.session());
    app.post("/synthetic-login", (req, res, next) => {
      req.login({
        id: "synthetic-user",
        claims: { sub: "synthetic-user", exp: Math.floor(Date.now() / 1000) + 3600 },
        refresh_token: legacyRefresh,
        access_token: legacyAccess,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }, error => error ? next(error) : res.json({ ok: true }));
    });
    app.get("/private", (req, res) => {
      const user = req.user as Record<string, unknown> | undefined;
      observedRefresh = user?.refresh_token;
      observedAccess = user?.access_token;
      res.status(req.isAuthenticated() ? 200 : 401).end();
    });
    app.get("/api/auth/user", (req, res) => {
      const user = req.user as { claims?: { sub?: string } } | undefined;
      res.json({ id: user?.claims?.sub ?? null });
    });
    app.post("/synthetic-refresh", async (req, res) => {
      try {
        await applyRefreshResponseAndPersist(
          req.user as Record<string, unknown>,
          req.session,
          {
            claims: () => ({ sub: "synthetic-user", exp: Math.floor(Date.now() / 1000) + 3600 }),
            refresh_token: rotatedRefresh,
          },
          callback => req.session.save(callback),
        );
        res.json({ ok: true });
      } catch {
        res.status(503).json({ message: "Session update unavailable" });
      }
    });
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(503).json({ message: "Session unavailable" });
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as import("node:net").AddressInfo).port;
    const runPath = path.join(leaseDirectory, "run.json");
    const run = JSON.parse(fs.readFileSync(runPath, "utf8"));
    run.fixtureRoot = fixture.root;
    fs.writeFileSync(runPath, JSON.stringify(run, null, 2), { mode: 0o600 });
  }, 60_000);

  it("stores new login refresh credentials as ciphertext only and exposes no token in the user API", async () => {
    const login = await request("/synthetic-login", "POST");
    expect(login.status).toBe(200);
    expect(login.cookie).toBeTruthy();
    const sid = sessionId(login.cookie!);
    const raw = await storedSession(sid);
    expect(typeof raw.cookie.expires).toBe("string");
    expect(raw.cookie).not.toHaveProperty("_expires");
    expect(Date.parse(raw.cookie.expires) - Date.now()).toBeGreaterThan(45_000);
    expect(Date.parse(raw.cookie.expires) - Date.now()).toBeLessThanOrEqual(60_000);
    // Compare in PostgreSQL UTC instead of letting pg parse a timezone-less timestamp in Node's local zone.
    const storedExpiry = (await pool!.query(
      "SELECT (EXTRACT(EPOCH FROM expire AT TIME ZONE 'UTC') * 1000)::double precision AS expire_ms FROM http_sessions WHERE sid=$1", [sid],
    )).rows[0].expire_ms;
    expect(Math.abs(Number(storedExpiry) - Date.parse(raw.cookie.expires))).toBeLessThan(2000);
    const user = raw.passport.user;
    expect(isEncryptedRefreshToken(user.refresh_token)).toBe(true);
    expect(user.refresh_token.keyId).toBe("active");
    expect(user.access_token).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain(legacyRefresh);
    expect(JSON.stringify(raw)).not.toContain(legacyAccess);

    const api = await request("/api/auth/user", "GET", login.cookie);
    expect(api.status).toBe(200);
    expect(api.body).toBe(JSON.stringify({ id: "synthetic-user" }));
    expect(api.body).not.toContain(legacyRefresh);
    expect(api.body).not.toContain(legacyAccess);
    expect((await request("/private", "GET", login.cookie)).status).toBe(200);
    expect(observedRefresh).toBe(legacyRefresh);
    expect(observedAccess).toBeUndefined();
  });

  it("never recreates a newly saved session after deletion through a late save", async () => {
    const sid = `new-lifecycle-${fixtureNonce}`;
    const live = {
      cookie: Object.assign(new session.Cookie(), { maxAge: 60_000, httpOnly: true, secure: true, sameSite: "lax" }),
      passport: { user: { claims: { sub: "synthetic-lifecycle-user" }, refresh_token: legacyRefresh } },
    } as unknown as session.SessionData;
    const save = () => new Promise<void>((resolve, reject) => {
      store!.set(sid, live, error => error ? reject(error) : resolve());
    });
    await save();
    expect(live.__srePersisted).toBe(true);
    expect(live.cookie).toBeInstanceOf(session.Cookie);
    expect(live.cookie.expires).toBeInstanceOf(Date);
    expect((live as any).passport.user.refresh_token).toBe(legacyRefresh);
    expect(isEncryptedRefreshToken((await storedSession(sid)).passport.user.refresh_token)).toBe(true);
    await new Promise<void>((resolve, reject) => {
      store!.destroy(sid, error => error ? reject(error) : resolve());
    });
    await expect(save()).rejects.toThrow("Session storage operation failed");
    const remaining = await pool!.query("SELECT count(*)::int AS count FROM http_sessions WHERE sid=$1", [sid]);
    expect(remaining.rows[0].count).toBe(0);
  });

  it("reads a legacy plaintext session without forcing logout, then encrypts its refresh writeback", async () => {
    const sid = `legacy-${fixtureNonce}`;
    const legacyUser = {
      id: "synthetic-legacy-user",
      claims: { sub: "synthetic-legacy-user", exp: Math.floor(Date.now() / 1000) + 3600 },
      refresh_token: legacyRefresh,
      access_token: legacyAccess,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    const legacy = {
      cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000), secure: true, httpOnly: true, sameSite: "lax", path: "/" },
      passport: { user: legacyUser },
    };
    await pool!.query(
      "INSERT INTO http_sessions (sid,sess,expire) VALUES ($1,$2,now()+interval '1 minute')",
      [sid, JSON.stringify(legacy)],
    );
    const cookie = signedCookie(sid);
    expect((await request("/private", "GET", cookie)).status).toBe(200);
    expect(observedRefresh).toBe(legacyRefresh);
    expect(observedAccess).toBeUndefined();
    const beforeWriteback = await storedSession(sid);
    expect(beforeWriteback.passport.user.refresh_token).toBe(legacyRefresh);

    const refreshed = await request("/synthetic-refresh", "POST", cookie);
    expect(refreshed.status).toBe(200);
    const afterWriteback = await storedSession(sid);
    const stored = afterWriteback.passport.user;
    expect(isEncryptedRefreshToken(stored.refresh_token)).toBe(true);
    expect(stored.refresh_token.keyId).toBe("active");
    expect(stored.access_token).toBeUndefined();
    expect(JSON.stringify(afterWriteback)).not.toContain(legacyRefresh);
    expect(JSON.stringify(afterWriteback)).not.toContain(legacyAccess);
    expect(vault.decrypt(stored.refresh_token)).toBe(rotatedRefresh);
    expect((await request("/private", "GET", cookie)).status).toBe(200);
    expect(observedRefresh).toBe(rotatedRefresh);
  });

  it("reads previous-key ciphertext and writes the next refresh with the active key", async () => {
    const sid = `rotating-${fixtureNonce}`;
    const oldToken = "synthetic-old-key-refresh";
    const oldSession = {
      cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000), secure: true, httpOnly: true, sameSite: "lax", path: "/" },
      passport: { user: {
        id: "synthetic-rotating-user",
        claims: { sub: "synthetic-rotating-user", exp: Math.floor(Date.now() / 1000) + 3600 },
        refresh_token: oldVault.encrypt(oldToken),
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      } },
    };
    await pool!.query(
      "INSERT INTO http_sessions (sid,sess,expire) VALUES ($1,$2,now()+interval '1 minute')",
      [sid, JSON.stringify(oldSession)],
    );
    const cookie = signedCookie(sid);
    expect((await request("/private", "GET", cookie)).status).toBe(200);
    expect(observedRefresh).toBe(oldToken);
    expect((await request("/synthetic-refresh", "POST", cookie)).status).toBe(200);
    const row = await storedSession(sid);
    expect(row.passport.user.refresh_token.keyId).toBe("active");
    expect(vault.decrypt(row.passport.user.refresh_token)).toBe(rotatedRefresh);
    expect(JSON.stringify(row)).not.toContain(oldToken);
  });

  it("rejects tampered ciphertext with sanitized response and no credential-shaped logs", async () => {
    const login = await request("/synthetic-login", "POST");
    const sid = sessionId(login.cookie!);
    const row = await storedSession(sid);
    const envelope = row.passport.user.refresh_token;
    const first = envelope.ciphertext[0] === "A" ? "B" : "A";
    row.passport.user.refresh_token.ciphertext = first + envelope.ciphertext.slice(1);
    await pool!.query("UPDATE http_sessions SET sess=$1 WHERE sid=$2", [JSON.stringify(row), sid]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request("/private", "GET", login.cookie);
      expect(response.status).toBe(503);
      expect(response.body).toBe(JSON.stringify({ message: "Session unavailable" }));
      expect(response.body).not.toContain(legacyRefresh);
      expect(JSON.stringify(log.mock.calls)).not.toContain(legacyRefresh);
      expect(JSON.stringify(log.mock.calls)).not.toContain(legacyAccess);
    } finally {
      log.mockRestore();
    }
  });

  afterAll(async () => {
    const stoppedAt = new Date().toISOString();
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    store?.close();
    if (pool) await pool.end();
    let markerMatched = false;
    let fixtureAbsent = false;
    if (fixture) {
      const ownerPath = path.join(fixture.root, "somr474-owner.json");
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      markerMatched = owner.nonce === fixtureNonce &&
        fs.realpathSync(fixture.root) === fixture.root &&
        fs.readFileSync(path.join(fixture.root, "ownership"), "utf8") === "somr432-owned-synthetic-postgres-v1";
      if (!markerMatched) throw new Error("synthetic fixture ownership verification failed; refusing cleanup");
      await fixture.cleanup();
      fixtureAbsent = !fs.existsSync(fixture.root);
    }
    const cleanupReceipt = {
      nonce: fixtureNonce,
      stoppedAt,
      serverStopped: !server?.listening,
      poolClosed: true,
      storeClosed: true,
      markerMatched,
      fixtureAbsent,
      ownerDatabaseUsed: false,
    };
    if (leaseDirectory) {
      fs.writeFileSync(path.join(leaseDirectory, "cleanup.json"), JSON.stringify(cleanupReceipt, null, 2), { mode: 0o600 });
      fs.chmodSync(path.join(leaseDirectory, "cleanup.json"), 0o600);
    }
    if (temporaryEvidenceDirectory) {
      fs.rmSync(temporaryEvidenceDirectory, { recursive: true });
      temporaryEvidenceDirectory = "";
    }
    if (fixture && !fixtureAbsent) throw new Error("synthetic PostgreSQL fixture was not removed");
  }, 60_000);
});
