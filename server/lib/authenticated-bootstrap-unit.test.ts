import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createAuthenticatedBootstrapUnit, type BootstrapUnit } from "./authenticated-bootstrap-unit";
import { BoundaryError, revalidate } from "./org-context";
import { startFixture, verifyFixture } from "./ownership-fixture";

const request = (sub: string) => ({ isAuthenticated: () => true, user: { claims: { sub } } });
describe("authenticated bootstrap transaction: actual disposable PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>, pool: Pool;
  beforeAll(async () => {
    fixture = await startFixture("bootstrap-unit");
    await fixture.client.query(`INSERT INTO users(id) VALUES ('bootstrap-a'),('bootstrap-b');
      INSERT INTO organizations(org_id,display_name) VALUES ('bootstrap-other','Other');
      INSERT INTO organization_members(org_id,user_id,role) VALUES ('bootstrap-other','bootstrap-b','owner');
      CREATE TABLE public.bootstrap_probe(id text PRIMARY KEY,value integer NOT NULL)`);
    verifyFixture(fixture.root);
    pool = new Pool({ host: fixture.root + "/socket", port: 5432, user: "synthetic", database: "postgres", password: "", ssl: false,
      max: 3, connectionTimeoutMillis: 5000, options: "-c statement_timeout=10000 -c lock_timeout=5000" });
  }, 60000);
  afterAll(async () => { if (pool) await pool.end(); if (fixture) await fixture.cleanup(); }, 60000);

  it("rejects malformed, throwing or unauthenticated actors before any connection", async () => {
    let connects = 0;
    const units = createAuthenticatedBootstrapUnit({ connect: async () => { connects++; throw Error("private URL"); } } as any);
    const bad: any[] = [{}, request(" "), request("__proto__"), request("x".repeat(201)), request("x\u0000"),
      { ...request("bootstrap-a"), isAuthenticated: () => false }, { ...request("bootstrap-a"), isAuthenticated: () => { throw Error("private token"); } },
      { get user() { throw Error("private claim"); }, isAuthenticated: () => true }];
    for (const r of bad) await expect(units.run(r, async () => 0)).rejects.toMatchObject({ status: 401, message: "Authentication required" });
    expect(connects).toBe(0);
  });
  it("refuses a missing persisted subject and locks the actor before a callback can run", async () => {
    let invoked = false;
    await expect(createAuthenticatedBootstrapUnit(pool).run(request("unknown-persisted-user"), async () => { invoked = true; }))
      .rejects.toMatchObject({ status: 403 });
    expect(invoked).toBe(false);
    const seen: string[] = [];
    const units = createAuthenticatedBootstrapUnit({ connect: async () => {
      const client = await pool.connect(); return { query: (sql: string, values?: any[]) => { seen.push(sql); return client.query(sql, values); },
        release: (destroy: boolean) => client.release(destroy) } as any;
    } });
    await units.run(request("bootstrap-a"), async unit => { expect(unit.actorUserId).toBe("bootstrap-a"); seen.push("CALLBACK"); });
    expect(seen.slice(0, 3)).toEqual(["BEGIN", "SELECT id FROM public.users WHERE id=$1 FOR UPDATE", "CALLBACK"]);
  });
  it("mints a normal432 capability only after membership exists, on the same checked-out transaction", async () => {
    let escaped: BootstrapUnit | undefined;
    const units = createAuthenticatedBootstrapUnit(pool);
    const result = await units.run({ ...request("bootstrap-a"), body: { userId: "bootstrap-b", email: "other@example.invalid" } }, async unit => {
      escaped = unit;
      const before = (await unit.tx.query("SELECT pg_backend_pid() pid,txid_current() tx")).rows[0];
      await unit.tx.query("INSERT INTO public.organizations(org_id,display_name) VALUES ($1,$2)", ["bootstrap-private", "Private"]);
      await unit.tx.query("INSERT INTO public.organization_members(org_id,user_id,role) VALUES ($1,$2,'owner')", ["bootstrap-private", unit.actorUserId]);
      const context = await unit.resolveContext();
      expect(context.actorUserId).toBe("bootstrap-a"); expect(context.orgId).toBe("bootstrap-private");
      const after = await unit.db.transaction(async tx => {
        await revalidate(tx, unit.db, context);
        await tx.query("INSERT INTO public.bootstrap_probe VALUES ($1,$2)", ["capability", 1]);
        return (await tx.query("SELECT pg_backend_pid() pid,txid_current() tx")).rows[0];
      });
      expect(after).toEqual(before); expect(Object.isFrozen(unit)).toBe(true); return context.orgId;
    });
    expect(result).toBe("bootstrap-private");
    await expect(escaped!.resolveContext()).rejects.toMatchObject({ status: 503 });
    await expect(escaped!.tx.query("INSERT INTO public.bootstrap_probe VALUES ('expired',2)")).rejects.toMatchObject({ status: 503 });
    await expect(escaped!.db.transaction(async () => 0)).rejects.toMatchObject({ status: 503 });
  });
  it("cannot turn a caught nested error or transaction escape into partial success", async () => {
    const units = createAuthenticatedBootstrapUnit(pool);
    for (const sql of ["COMMIT", "SAVEPOINT escape", "SELECT 1; COMMIT"]) {
      await expect(units.run(request("bootstrap-a"), async unit => {
        await unit.tx.query("INSERT INTO public.bootstrap_probe VALUES ('poison',1)");
        try { await unit.tx.query(sql); } catch { /* still poisoned */ }
      })).rejects.toMatchObject({ status: 503 });
    }
    await expect(units.run(request("bootstrap-a"), async unit => {
      await unit.tx.query("INSERT INTO public.bootstrap_probe VALUES ('poison',1)");
      try { await unit.db.transaction(async () => { throw new BoundaryError(400); }); } catch { /* still poisoned */ }
    })).rejects.toMatchObject({ status: 503 });
    expect((await fixture.client.query("SELECT count(*)::int n FROM bootstrap_probe WHERE id='poison'")).rows[0].n).toBe(0);
  });
  it("observes pending SQL, rolls back caught SQL failure and refuses a changed Passport subject", async () => {
    const units = createAuthenticatedBootstrapUnit(pool);
    await units.run(request("bootstrap-a"), async unit => { void unit.tx.query("INSERT INTO public.bootstrap_probe VALUES ('pending',1)"); });
    await expect(units.run(request("bootstrap-a"), async unit => {
      await unit.tx.query("INSERT INTO public.bootstrap_probe VALUES ('failed',1)");
      try { await unit.tx.query("INSERT INTO public.bootstrap_probe VALUES ('failed',2)"); } catch { }
    })).rejects.toMatchObject({ status: 503 });
    const mutable = request("bootstrap-a");
    await expect(units.run(mutable, async unit => { mutable.user.claims.sub = "bootstrap-b"; await unit.resolveContext(); }))
      .rejects.toMatchObject({ status: 401 });
    expect((await fixture.client.query("SELECT id FROM bootstrap_probe ORDER BY id")).rows.map(row => row.id)).toEqual(["capability", "pending"]);
  });
});

describe("bootstrap unit transport cleanup, injected non-database failure only", () => {
  it("destroys uncertain BEGIN/COMMIT and failed rollback clients exactly once", async () => {
    for (const failure of ["BEGIN", "COMMIT", "ROLLBACK", "ABORTED_COMMIT"]) {
      const releases: boolean[] = [], calls: string[] = [];
      const client: any = { query: async (sql: string) => {
        calls.push(sql); if (sql === failure) throw Error("private transport");
        if (sql.startsWith("SELECT id FROM")) return { rows: [{ id: "synthetic" }], rowCount: 1 };
        return { rows: [], rowCount: 0, command: sql === "COMMIT" && failure === "ABORTED_COMMIT" ? "ROLLBACK" : sql };
      }, release: (destroy: boolean) => releases.push(destroy) };
      await expect(createAuthenticatedBootstrapUnit({ connect: async () => client }).run(request("synthetic"), async () => {
        if (failure === "ROLLBACK") throw new BoundaryError(400); return 1;
      })).rejects.toMatchObject({ status: 503, message: "Service unavailable" });
      expect(releases).toEqual([true]);
      expect(calls.filter(sql => sql === "COMMIT").length).toBe(["COMMIT", "ABORTED_COMMIT"].includes(failure) ? 1 : 0);
    }
  });
});
