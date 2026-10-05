import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import express, { type Request } from "express";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { BoundaryError, type Transaction } from "../lib/org-context";
import { adoptionPath, createAdoptionDatabase, mountDevelopmentAdoption, prepareAdoptionServices,
  readAdoptionConfig, type AdoptionConfig } from "./development-policy-adoption";
vi.mock("../db", () => { throw Error("FORBIDDEN ambient database import"); });
vi.mock("../replit_integrations/auth", () => { throw Error("FORBIDDEN ambient auth import"); });
import { runPolicyAdoption } from "../../script/run-policy-adoption";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const origin = "https://owned-synthetic.replit.dev";
const t = Date.parse("2026-01-01T00:00:00.000Z");
const env = () => ({ SOMR_POLICY_ADOPTION: "enabled", NODE_ENV: "development", SOMR_POLICY_ADOPTION_ORIGIN: origin,
  SOMR_POLICY_ADOPTION_ACTOR_SHA256: hash("adopt-a"), SOMR_POLICY_ADOPTION_EXPIRES_AT: new Date(t + 60_000).toISOString(),
  SOMR_POLICY_ADOPTION_DATABASE_MD5: "a".repeat(32), SOMR_POLICY_ADOPTION_ENDPOINT_MD5: "b".repeat(32), SOMR_POLICY_ADOPTION_ROLE_MD5: "c".repeat(32) });

describe("short-lived authenticated maintenance boundary (synthetic loopback requests only)", () => {
  let server: Server, local: string, actor: any, original: Request | undefined, clock: number, calls: number;
  let seed: ReturnType<typeof vi.fn>, load: ReturnType<typeof vi.fn>, reconcile: ReturnType<typeof vi.fn>;
  beforeAll(async () => {
    const app = express(); app.set("trust proxy", 1); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
    const config = readAdoptionConfig(env(), t);
    const authenticate: any = (req: Request, res: any, next: any) => {
      if (actor === null) return res.status(401).send("Authentication required");
      // Fixture-only principal, never used by the live launcher.
      req.user = { claims: { sub: actor } } as any; req.isAuthenticated = (() => true) as any; original = req; next();
    };
    mountDevelopmentAdoption(app, { config, authenticate, now: () => clock,
      getServices: async () => { calls++; return { seed: (r: Request) => seed(r), import: (r: Request) => load(r), reconcile: (r: Request) => reconcile(r) }; } });
    mountDevelopmentAdoption(app, { config: readAdoptionConfig({}), authenticate,
      getServices: async () => { throw Error("Disabled setup opened services"); } });
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw Error("Not loopback");
    local = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); expect(server.address()).toBeNull(); });
  beforeEach(() => {
    actor = "adopt-a"; original = undefined; clock = t; seed = vi.fn(async () => ({ privateMapping: "must not render" }));
    load = vi.fn(async () => ({})); reconcile = vi.fn(async () => ({ clean: true, counts: { ownedSessions: 4 } }));
  });
  async function http(method: string, path = adoptionPath, options: { headers?: Record<string, string>; body?: unknown } = {}) {
    const r = await fetch(local + path, { method, headers: { "X-Forwarded-Host": new URL(origin).host, "X-Forwarded-Proto": "https",
      Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    return { status: r.status, text: await r.text(), cache: r.headers.get("cache-control") };
  }
  it("defaults off without interpreting extra fields; launcher refuses before auth/database imports", async () => {
    expect(readAdoptionConfig({ SOMR_POLICY_ADOPTION_EXPIRES_AT: "bad" })).toEqual({ enabled: false });
    await expect(runPolicyAdoption({})).rejects.toThrow("Service unavailable");
    const app = express(); const get = vi.spyOn(app, "get"), post = vi.spyOn(app, "post");
    mountDevelopmentAdoption(app, { config: { enabled: false }, authenticate: vi.fn(), getServices: vi.fn() });
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it("refuses production, retention, write-through, malformed origins, actor allowlist, expiry and database binding", () => {
    const bad = [{ NODE_ENV: "production" }, { REPLIT_DEPLOYMENT: "1" }, { REPLIT_DEPLOYMENT: "true" },
      { SOMR_POLICY_ADOPTION: "yes" }, { SESSION_RETENTION_PURGE_ENABLED: "true" }, { SOMR_LEGACY_WRITE_THROUGH: "enabled" },
      ...["https://live.replit.app", "https://pmhlabs.org", origin + "/", origin + "/x", "http://x.replit.dev", "https://user:secret@x.replit.dev", origin + ":444"].map(x => ({ SOMR_POLICY_ADOPTION_ORIGIN: x })),
      { SOMR_POLICY_ADOPTION_ACTOR_SHA256: "adopt-a" }, { SOMR_POLICY_ADOPTION_EXPIRES_AT: new Date(t).toISOString() },
      { SOMR_POLICY_ADOPTION_EXPIRES_AT: new Date(t + 900_001).toISOString() }, { SOMR_POLICY_ADOPTION_ROLE_MD5: "wrong" }];
    for (const change of bad) expect(() => readAdoptionConfig({ ...env(), ...change }, t)).toThrow("Service unavailable");
    const values = env(), config = readAdoptionConfig(values, t); values.SOMR_POLICY_ADOPTION_ORIGIN = "changed";
    expect(config.origin).toBe(origin); expect(Object.isFrozen(config.binding)).toBe(true);
  });
  it("serves a no-cache page without preparing services or running writes", async () => {
    const before = calls, r = await http("GET"); expect(r.status).toBe(200); expect(r.cache).toBe("no-store");
    expect(r.text).toContain('method="post"'); expect(seed).not.toHaveBeenCalled(); expect(calls).toBe(before);
  });
  it("passes the exact original authenticated request and does not disclose mapping output", async () => {
    const r = await http("POST", adoptionPath + "/seed", { body: {} }); expect(r.status).toBe(200);
    expect(seed).toHaveBeenCalledWith(original); expect(r.text).not.toContain("must not render"); expect(load).not.toHaveBeenCalled();
    const imported = await http("POST", adoptionPath + "/import"); expect(imported.status).toBe(200); expect(load).toHaveBeenCalledWith(original);
  });
  it("refuses another actor or absent/malformed authentication without calling services", async () => {
    for (const value of [null, "adopt-b", "", " ", "__proto__", "x\u0000", "x".repeat(201), { sub: "adopt-a" }]) {
      actor = value; expect((await http("POST", adoptionPath + "/seed")).status).toBe(value === "adopt-b" ? 403 : 401);
    }
    expect(seed).not.toHaveBeenCalled();
  });
  it("refuses cross-origin, missing-browser-intent, host/protocol and request identity injection", async () => {
    for (const headers of [{ Origin: "https://foreign.replit.dev" }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "" }, { "X-Forwarded-Host": "foreign.replit.dev" }, { "X-Forwarded-Proto": "http" }])
      expect((await http("POST", adoptionPath + "/seed", { headers })).status).toBe(403);
    for (const body of [{ ownerUserId: "adopt-b" }, [], "adopt-a"])
      expect((await http("POST", adoptionPath + "/seed", { body })).status).toBe(400);
    expect((await http("POST", adoptionPath + "/seed?actor=adopt-a")).status).toBe(400); expect(seed).not.toHaveBeenCalled();
  });
  it("expires GET and POST operations without invoking services", async () => {
    clock = t + 60_000;
    expect((await http("GET")).status).toBe(503); expect((await http("POST", adoptionPath + "/seed")).status).toBe(503);
    expect(seed).not.toHaveBeenCalled();
  });
  it("bounds private failures and refuses an unclean reconciliation", async () => {
    seed.mockRejectedValue(Error("private DATABASE_URL and token"));
    const r = await http("POST", adoptionPath + "/seed"); expect(r).toMatchObject({ status: 503, text: "Service unavailable" });
    reconcile.mockResolvedValue({ clean: false }); expect((await http("POST", adoptionPath + "/reconcile")).status).toBe(503);
    reconcile.mockResolvedValue({ clean: true, counts: {} }); expect((await http("POST", adoptionPath + "/reconcile")).status).toBe(200);
  });
  it("refuses overlapping operations and clears the busy gate after failure", async () => {
    let release!: () => void, entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
    seed.mockImplementation(async () => { entered(); await new Promise<void>(r => { release = r; }); throw Error("private"); });
    const first = http("POST", adoptionPath + "/seed"); await ready;
    expect((await http("POST", adoptionPath + "/import")).status).toBe(503); expect(load).not.toHaveBeenCalled();
    release(); expect((await first).status).toBe(503); expect((await http("POST", adoptionPath + "/import")).status).toBe(200);
  });
});

describe("checked-out adoption transaction and real synthetic seed/import/reconciliation", () => {
  let f: Awaited<ReturnType<typeof startFixture>>, pool: Pool, config: AdoptionConfig;
  const req = { isAuthenticated: () => true, user: { claims: { sub: "adopt-a" } } } as any;
  beforeAll(async () => {
    f = await startFixture("development-adoption"); verifyFixture(f.root);
    pool = new Pool({ host: f.root + "/socket", user: "synthetic", database: "postgres", password: "", port: 5432, ssl: false,
      max: 3, connectionTimeoutMillis: 5000, options: "-c statement_timeout=30000 -c lock_timeout=5000" });
    const b = (await f.client.query(`SELECT md5(current_database()) AS database,
      md5(coalesce(inet_server_addr()::text,'unix-socket')||':'||coalesce(inet_server_port()::text,'')) AS endpoint,md5(current_user) AS role`)).rows[0];
    config = Object.freeze({ enabled: true, expiresAt: Date.now() + 900_000, binding: b });
    await f.client.query("INSERT INTO users(id) VALUES('adopt-a'),('adopt-b')");
    await f.client.query("INSERT INTO user_settings(user_id,timezone,day_start_hour,window_days) VALUES('adopt-a','America/New_York',6,14)");
    for (const slug of ["martial-arts", "meditation", "fitness", "music"]) await f.client.query(
      "INSERT INTO sessions(id,user_id,domain,duration_minutes,timestamp,notes) VALUES($1,'adopt-a',$2,1,'2020-01-01T00:00:00.123456Z','synthetic')", [slug, slug]);
    await f.client.query("INSERT INTO sessions(id,domain,duration_minutes,timestamp) VALUES('unowned','music',1,now())");
    await f.client.query("CREATE TABLE public.adoption_probe(id text PRIMARY KEY)");
  }, 60_000);
  afterAll(async () => { try { if (pool) await pool.end(); } finally { if (f) await f.cleanup(); } }, 60_000);
  async function legacy() {
    const rows = [];
    for (const table of ["users", "sessions", "session_edits", "user_settings", "deviations", "http_sessions"])
      rows.push((await f.client.query(`SELECT to_jsonb(t) raw FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows);
    return JSON.stringify(rows);
  }
  it("performs the reviewed seed/import then clean collection reconciliation, preserving all original records and idempotence", async () => {
    const before = await legacy(), services = await prepareAdoptionServices(pool, config);
    await services.seed(req); await services.seed(req); await services.import(req);
    expect(await services.reconcile(req)).toMatchObject({ clean: true, counts: { ownedSessions: 4, canonicalSessions: 4, unownedSessions: 1 } });
    const audits = (await f.client.query("SELECT to_jsonb(a) raw FROM audit_events a ORDER BY audit_event_id")).rows;
    await expect(services.seed(req)).rejects.toMatchObject({ status: 403 });
    await services.import(req); await services.reconcile(req);
    expect((await f.client.query("SELECT to_jsonb(a) raw FROM audit_events a ORDER BY audit_event_id")).rows).toEqual(audits);
    expect(await legacy()).toBe(before);
  });
  it("refuses mismatched database binding before the callback and rolls back", async () => {
    const db = createAdoptionDatabase(pool, { ...config.binding!, role: "f".repeat(32) }); const fn = vi.fn(async () => 1);
    await expect(db.transaction(fn)).rejects.toMatchObject({ status: 503 }); expect(fn).not.toHaveBeenCalled();
  });
  it("poisons caught SQL failures and refuses transaction control or legacy mutations", async () => {
    const db = createAdoptionDatabase(pool, config.binding!);
    for (const sql of ["COMMIT", "ROLLBACK", "SELECT 1; COMMIT", "UPDATE sessions SET duration_minutes=99", "DELETE FROM sessions"])
      await expect(db.transaction(async tx => { await tx.query("INSERT INTO adoption_probe VALUES ('poison')");
        try { await tx.query(sql); } catch {} })).rejects.toMatchObject({ status: 503 });
    await expect(db.transaction(async tx => { await tx.query("INSERT INTO adoption_probe VALUES ('duplicate')");
      try { await tx.query("INSERT INTO adoption_probe VALUES ('duplicate')"); } catch {} })).rejects.toMatchObject({ status: 503 });
    expect((await f.client.query("SELECT count(*)::int n FROM adoption_probe")).rows[0].n).toBe(0);
  });
  it("awaits pending statements and expires escaped transaction handles", async () => {
    const db = createAdoptionDatabase(pool, config.binding!); let escaped: Transaction | undefined;
    await db.transaction(async tx => { escaped = tx; void tx.query("INSERT INTO adoption_probe VALUES ('pending')"); });
    expect((await f.client.query("SELECT count(*)::int n FROM adoption_probe WHERE id='pending'")).rows[0].n).toBe(1);
    await expect(escaped!.query("INSERT INTO adoption_probe VALUES ('escaped')")).rejects.toMatchObject({ status: 503 });
  });
  it("rolls back callback failure with bounded errors", async () => {
    const db = createAdoptionDatabase(pool, config.binding!);
    await expect(db.transaction(async tx => { await tx.query("INSERT INTO adoption_probe VALUES ('callback')"); throw Error("private"); }))
      .rejects.toMatchObject({ status: 503, message: "Service unavailable" });
    expect((await f.client.query("SELECT count(*)::int n FROM adoption_probe WHERE id='callback'")).rows[0].n).toBe(0);
  });
  it("destroys a client after an ambiguous COMMIT or rollback failure", async () => {
    for (const mode of ["ambiguous", "rollback"]) {
      const release = vi.fn();
      const client = { release, query: async (sql: string) => {
        if (sql.startsWith("SELECT md5")) return { rows: [config.binding], command: "SELECT" };
        if (sql === "COMMIT" && mode === "ambiguous") throw Error("private connection");
        if (sql === "ROLLBACK" && mode === "rollback") throw Error("private rollback");
        return { rows: [], command: sql.split(" ")[0] };
      } };
      const db = createAdoptionDatabase({ connect: async () => client } as any, config.binding!);
      await expect(db.transaction(async () => { if (mode === "rollback") throw new BoundaryError(400); return 1; }))
        .rejects.toMatchObject({ status: 503 }); expect(release).toHaveBeenCalledWith(true);
    }
  });
});
