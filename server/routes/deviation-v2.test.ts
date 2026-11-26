import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { startFixture, verifyFixture } from "../lib/ownership-fixture";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createDeviationServiceV2 } from "../services/deviation-service-v2";
import { createDeviationV2Router } from "./deviation-v2";

const startAt = "2026-04-01T08:00:00.123Z";
const endAt = "2026-04-04T08:00:00.456Z";
const reason = "Synthetic planned recovery break";
const changeReason = "Synthetic lifecycle test";
const createBody = (practiceIds: string[], extra: Record<string, unknown> = {}) => ({
  startAt, endAt, reason, changeReason, practiceIds, type: "stitch", ...extra,
});

describe("authenticated selected-practice break lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>;
  let pool: Pool;
  let server: Server;
  let base: string;
  let connects = 0;
  const clock = () => new Date("2026-04-02T12:30:00.000Z");

  async function snapshot() {
    const rows: Record<string, unknown> = {};
    for (const table of ["deviations_v2", "deviation_domains", "audit_events", "owner_write_resource_budgets",
      "sessions", "observations"]) {
      rows[table] = (await fixture.client.query(
        `SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`,
      )).rows;
    }
    return JSON.stringify(rows);
  }
  async function call(path: string, actor?: string, method = "GET", body?: unknown) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(actor ? { "x-synthetic-fixture-actor": actor } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async function audits(entityId?: string) {
    const values: unknown[] = ["break-a"];
    let filter = "actor_user_id=$1 AND entity_type IN ('deviations_v2','deviation_domains')";
    if (entityId !== undefined) {
      values.push(entityId);
      filter += " AND entity_id=$2";
    }
    return (await fixture.client.query(
      `SELECT entity_type,entity_id,action,reason,"before","after",occurred_at
       FROM public.audit_events WHERE ${filter} ORDER BY occurred_at,audit_event_id`,
      values,
    )).rows;
  }

  beforeAll(async () => {
    fixture = await startFixture("somr438-deviation-http");
    await fixture.client.query(`INSERT INTO public.users(id) VALUES
      ('break-a'),('break-b'),('break-c');
      INSERT INTO public.organizations(org_id,display_name) VALUES
      ('break-org-a','Synthetic A'),('break-org-b','Synthetic B');
      INSERT INTO public.organization_members(org_id,user_id,role) VALUES
      ('break-org-a','break-a','owner'),('break-org-a','break-c','member'),('break-org-b','break-b','owner');
      INSERT INTO public.domains(domain_id,org_id,owner_user_id,slug,display_name) VALUES
      ('break-a-meditation','break-org-a','break-a','meditation','Meditation'),
      ('break-a-exercise','break-org-a','break-a','exercise','Exercise'),
      ('break-a-reading','break-org-a','break-a','reading','Reading'),
      ('break-b-meditation','break-org-b','break-b','meditation','Other Meditation'),
      ('break-c-meditation','break-org-a','break-c','member-meditation','Member Meditation');
      INSERT INTO public.sessions(id,user_id,domain,timestamp,duration)
      VALUES ('synthetic-history-entry','break-a','meditation','2026-03-01T08:00:00Z',20)`);
    verifyFixture(fixture.root);
    pool = new Pool({
      host: fixture.root + "/socket",
      port: 5432,
      user: "synthetic",
      database: "postgres",
      password: "",
      ssl: false,
      max: 6,
      connectionTimeoutMillis: 5000,
      options: "-c statement_timeout=10000 -c lock_timeout=5000",
    });
    const service = createDeviationServiceV2(createPinnedOwnershipUnit({
      connect: async () => { connects++; return pool.connect(); },
    }), { clock });
    const app = express();
    app.use("/api/v2/deviations", createDeviationV2Router({
      service,
      authenticate: (req: any, res, next) => {
        const actor = req.get("x-synthetic-fixture-actor");
        if (!["break-a", "break-b", "break-c"].includes(actor)) {
          res.status(401).json({ message: "Authentication required" });
          return;
        }
        req.user = { claims: { sub: actor } };
        req.isAuthenticated = () => true;
        next();
      },
    }));
    server = createServer(app);
    await new Promise<void>((resolve, reject) =>
      server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic HTTP fixture did not bind");
    base = `http://127.0.0.1:${address.port}/api/v2/deviations`;
  }, 60000);

  beforeEach(async () => {
    await fixture.client.query("DELETE FROM public.owner_write_resource_budgets");
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
    if (pool) await pool.end();
    if (fixture) await fixture.cleanup();
  }, 60000);

  it("rejects unauthenticated requests before a database connection", async () => {
    const beforeConnects = connects;
    expect((await call("/", undefined, "GET")).status).toBe(401);
    expect((await call("/", undefined, "POST", createBody(["break-a-meditation"]))).status).toBe(401);
    expect(connects).toBe(beforeConnects);
  });

  it("creates an owned break with exact interval, required reasons and all selected practices in one history", async () => {
    const before = await snapshot();
    const response = await call("/", "break-a", "POST", createBody(["break-a-exercise", "break-a-meditation"]));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      startAt: startAt,
      endAt: endAt,
      reason,
      type: "stitch",
      scope: "selected",
      practiceIds: ["break-a-exercise", "break-a-meditation"],
      endedAt: null,
      deletedAt: null,
    });
    const id = response.body.deviationId as string;
    const stored = (await fixture.client.query(`SELECT deviation_id,start_at::text,end_at::text,reason,scope,type
      FROM public.deviations_v2 WHERE deviation_id=$1`, [id])).rows[0];
    expect(stored).toMatchObject({
      deviation_id: id,
      start_at: "2026-04-01 08:00:00.123+00",
      end_at: "2026-04-04 08:00:00.456+00",
      reason,
      scope: "selected",
      type: "stitch",
    });
    expect((await fixture.client.query(
      "SELECT domain_id FROM public.deviation_domains WHERE deviation_id=$1 ORDER BY domain_id", [id],
    )).rows.map(row => row.domain_id)).toEqual(["break-a-exercise", "break-a-meditation"]);
    const events = await audits(JSON.stringify([id]));
    expect(events.map(event => [event.entity_type, event.action])).toEqual([
      ["deviations_v2", "create"],
    ]);
    const associationEvents = await fixture.client.query(`SELECT entity_type,action,entity_id
      FROM public.audit_events WHERE actor_user_id='break-a' AND entity_type='deviation_domains'
        AND entity_id=ANY($1::text[]) ORDER BY entity_id`,
    [[JSON.stringify([id, "break-a-exercise"]), JSON.stringify([id, "break-a-meditation"])]]);
    expect(associationEvents.rows).toHaveLength(2);
    expect(associationEvents.rows.map(event => [event.entity_type, event.action])).toEqual([
      ["deviation_domains", "create"],
      ["deviation_domains", "create"],
    ]);
    expect(await snapshot()).not.toBe(before);
    expect((await call(`/${id}`, "break-a")).body.practiceIds).toEqual(["break-a-exercise", "break-a-meditation"]);
  });

  it("validates every selected practice before writing and rejects foreign or duplicate selections", async () => {
    const before = await snapshot();
    expect((await call("/", "break-a", "POST", createBody(["break-a-meditation", "break-b-meditation"]))).status).toBe(404);
    expect((await call("/", "break-a", "POST", createBody(["break-a-meditation", "break-c-meditation"]))).status).toBe(404);
    expect((await call("/", "break-a", "POST", createBody(["break-a-meditation", "break-a-meditation"]))).status).toBe(400);
    expect((await call("/", "break-a", "POST", { ...createBody(["break-a-meditation"]), changeReason: " " })).status).toBe(400);
    expect(await snapshot()).toBe(before);
  });

  it("keeps owner and organization boundaries private for reads and mutations", async () => {
    const created = await call("/", "break-a", "POST", createBody(["break-a-meditation"]));
    const id = created.body.deviationId as string;
    const before = await snapshot();
    expect((await call(`/${id}`, "break-b")).status).toBe(404);
    expect((await call(`/${id}`, "break-c")).status).toBe(404);
    expect((await call(`/${id}`, "break-b", "PATCH", {
      ...createBody(["break-b-meditation"]),
    })).status).toBe(404);
    expect((await call(`/${id}`, "break-c", "DELETE", { changeReason })).status).toBe(404);
    expect(await snapshot()).toBe(before);
  });

  it("edits dates, reason and the selected set atomically; reordered repeated choices are a true no-op", async () => {
    const created = await call("/", "break-a", "POST", createBody(["break-a-meditation", "break-a-exercise"]));
    const id = created.body.deviationId as string;
    const edit = {
      startAt: "2026-04-01T09:00:00.123Z",
      endAt: "2026-04-05T09:00:00.456Z",
      reason: "Synthetic corrected break dates",
      changeReason: "Synthetic selected-practice correction",
      practiceIds: ["break-a-reading", "break-a-exercise"],
    };
    const changed = await call(`/${id}`, "break-a", "PATCH", edit);
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      startAt: edit.startAt,
      endAt: edit.endAt,
      reason: edit.reason,
      practiceIds: ["break-a-exercise", "break-a-reading"],
    });
    const beforeRetry = await snapshot();
    const retry = await call(`/${id}`, "break-a", "PATCH", {
      ...edit,
      changeReason: "Synthetic reordered no-op",
      practiceIds: ["break-a-exercise", "break-a-reading"],
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      startAt: edit.startAt,
      endAt: edit.endAt,
      reason: edit.reason,
      practiceIds: ["break-a-exercise", "break-a-reading"],
    });
    expect(await snapshot()).toBe(beforeRetry);
    expect((await fixture.client.query(
      "SELECT action FROM public.audit_events WHERE entity_type='deviations_v2' AND entity_id=$1 ORDER BY occurred_at",
      [JSON.stringify([id])],
    )).rows.map(row => row.action)).toEqual(["create", "update"]);
  });

  it("permits overlapping breaks and preserves historical practice rows through end and soft delete", async () => {
    const first = await call("/", "break-a", "POST", createBody(["break-a-meditation"]));
    const second = await call("/", "break-a", "POST", createBody(["break-a-meditation"], {
      startAt: "2026-04-02T08:00:00.000Z",
      endAt: "2026-04-05T08:00:00.000Z",
      reason: "Synthetic overlapping break",
    }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const id = first.body.deviationId as string;
    const beforeEndAudits = (await fixture.client.query(
      "SELECT count(*)::int AS count FROM public.audit_events WHERE entity_id=$1",
      [JSON.stringify([id])],
    )).rows[0].count;
    const ended = await call(`/${id}/end`, "break-a", "POST", { changeReason: "Synthetic end" });
    expect(ended.status).toBe(200);
    expect(ended.body.endedAt).toBe("2026-04-02T12:30:00.000Z");
    const afterEnd = await snapshot();
    const repeatedEnd = await call(`/${id}/end`, "break-a", "POST", { changeReason: "Synthetic repeated end" });
    expect(repeatedEnd.status).toBe(200);
    expect(repeatedEnd.body.endedAt).toBe(ended.body.endedAt);
    expect(await snapshot()).toBe(afterEnd);
    expect(beforeEndAudits).toBe(1);

    const sessionsBefore = (await fixture.client.query(
      "SELECT to_jsonb(s) AS row FROM public.sessions s ORDER BY id",
    )).rows;
    const deletion = await call(`/${id}`, "break-a", "DELETE", { changeReason: "Synthetic soft delete" });
    expect(deletion.status).toBe(200);
    expect(deletion.body.deletedAt).toBeTruthy();
    expect((await fixture.client.query(
      "SELECT count(*)::int AS count FROM public.deviation_domains WHERE deviation_id=$1", [id],
    )).rows[0].count).toBe(1);
    expect((await call("/", "break-a")).body.map((entry: any) => entry.deviationId)).not.toContain(id);
    expect((await call(`/${id}`, "break-a")).status).toBe(404);
    const afterDelete = await snapshot();
    const repeatedDelete = await call(`/${id}`, "break-a", "DELETE", { changeReason: "Synthetic repeated delete" });
    expect(repeatedDelete.status).toBe(200);
    expect(repeatedDelete.body.deletedAt).toBe(deletion.body.deletedAt);
    expect(await snapshot()).toBe(afterDelete);
    expect((await fixture.client.query(
      "SELECT to_jsonb(s) AS row FROM public.sessions s ORDER BY id",
    )).rows).toEqual(sessionsBefore);
  });

  it("rolls back edited fields, selected-practice changes and history after a late association failure", async () => {
    const created = await call("/", "break-a", "POST", createBody(["break-a-meditation", "break-a-exercise"]));
    const id = created.body.deviationId as string;
    const before = await snapshot();
    await fixture.client.query(`CREATE FUNCTION public.somr438_fail_late_association() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.domain_id='break-a-reading' THEN RAISE EXCEPTION 'synthetic association failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER somr438_fail_late_association BEFORE INSERT ON public.deviation_domains
      FOR EACH ROW EXECUTE FUNCTION public.somr438_fail_late_association()`);
    try {
      const response = await call(`/${id}`, "break-a", "PATCH", {
        startAt: "2026-04-01T10:00:00.000Z",
        endAt: "2026-04-06T10:00:00.000Z",
        reason: "Synthetic attempted edit",
        changeReason: "Synthetic late association rollback",
        practiceIds: ["break-a-reading"],
      });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ message: "Service unavailable" });
      expect(await snapshot()).toBe(before);
    } finally {
      await fixture.client.query(`DROP TRIGGER somr438_fail_late_association ON public.deviation_domains;
        DROP FUNCTION public.somr438_fail_late_association()`);
    }
  });

  it("rolls back row, association and history when the audit insert fails", async () => {
    await fixture.client.query(`CREATE FUNCTION public.somr438_fail_break_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entity_type='deviation_domains' AND NEW.action='create'
          THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER somr438_fail_break_audit BEFORE INSERT ON public.audit_events
      FOR EACH ROW EXECUTE FUNCTION public.somr438_fail_break_audit()`);
    const before = await snapshot();
    try {
      const response = await call("/", "break-a", "POST", createBody(["break-a-meditation"]));
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ message: "Service unavailable" });
      expect(await snapshot()).toBe(before);
    } finally {
      await fixture.client.query(`DROP TRIGGER somr438_fail_break_audit ON public.audit_events;
        DROP FUNCTION public.somr438_fail_break_audit()`);
    }
  });

  it("serializes competing edits and keeps the audit before/after chain consistent", async () => {
    const created = await call("/", "break-a", "POST", createBody(["break-a-meditation", "break-a-exercise"]));
    const id = created.body.deviationId as string;
    const changes = [
      {
        startAt: "2026-04-01T10:00:00.000Z",
        endAt: "2026-04-06T10:00:00.000Z",
        reason: "Synthetic competing edit one",
        changeReason: "Synthetic competing edit one",
        practiceIds: ["break-a-meditation", "break-a-reading"],
      },
      {
        startAt: "2026-04-01T11:00:00.000Z",
        endAt: "2026-04-07T11:00:00.000Z",
        reason: "Synthetic competing edit two",
        changeReason: "Synthetic competing edit two",
        practiceIds: ["break-a-exercise"],
      },
    ];
    const results = await Promise.all(changes.map(body => call(`/${id}`, "break-a", "PATCH", body)));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    const events = await fixture.client.query(`SELECT "before","after" FROM public.audit_events
      WHERE actor_user_id='break-a' AND entity_type='deviations_v2' AND entity_id=$1
      ORDER BY occurred_at,audit_event_id`, [JSON.stringify([id])]);
    expect(events.rows).toHaveLength(3);
    expect(events.rows[0].before).toBeNull();
    expect(events.rows[1].before).toEqual(events.rows[0].after);
    expect(events.rows[2].before).toEqual(events.rows[1].after);
    const current = (await fixture.client.query(
      "SELECT to_jsonb(d) AS row FROM public.deviations_v2 d WHERE deviation_id=$1", [id],
    )).rows[0].row;
    expect(events.rows[2].after).toEqual(current);
    const currentPractices = (await fixture.client.query(
      "SELECT domain_id FROM public.deviation_domains WHERE deviation_id=$1 ORDER BY domain_id", [id],
    )).rows.map(row => row.domain_id);
    expect(results.at(-1)?.body.practiceIds).toEqual(currentPractices);
  });
});
