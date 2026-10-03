import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { sessions, type Session } from "@shared/schema";

// Hoisted before storage's application dependencies. No pg client is imported.
const db = vi.hoisted(() => ({
  select: vi.fn(), update: vi.fn(), delete: vi.fn(),
}));
vi.mock("./db", () => ({ db }));
import { DatabaseStorage } from "./storage";

const storage = new DatabaseStorage();
const dialect = new PgDialect();
const NOW = new Date("2026-10-03T12:00:00.000Z");
// Independent calendar oracle: not calculated by importing startup or policy code.
const CUTOFF = new Date("2026-08-22T12:00:00.000Z");
const OWNERS = ["synthetic-retention-owner-ALPHA", "synthetic-retention-owner-BETA"];
const IDS = ["opaque:/synthetic A?#%", "opaque:/synthetic B?#%"];
type Query = Pick<ReturnType<PgDialect["sqlToQuery"]>, "sql" | "params">;
let predicates: Query[];
let ordering: Query[];
let writes: Record<string, unknown>[];
let projections: unknown[];
let rows: Session[];
let failure: Error | undefined;

function record(condition: SQL) {
  predicates.push(compile(condition));
}
function compile(condition: SQL): Query {
  const { sql, params } = dialect.sqlToQuery(condition);
  return { sql, params };
}
function result() {
  if (failure) throw failure;
  return structuredClone(rows);
}
function fixture(owner: string, id: string, deletedAt: Date | null): Session {
  return {
    userId: owner, id, domain: "music", durationMinutes: 47,
    timestamp: new Date("2026-01-11T09:17:00Z"),
    notes: "invented retention note", isAnomaly: true,
    anomalyNote: "invented anomaly explanation", deletedAt,
  };
}
function scoped(owner: string, id: string, state: "null" | "not null") {
  expect(predicates).toEqual([{
    sql: `("sessions"."user_id" = $1 and "sessions"."id" = $2 and "sessions"."deleted_at" is ${state})`,
    params: [owner, id],
  }]);
}
beforeEach(() => {
  vi.clearAllMocks();
  predicates = []; ordering = []; writes = []; projections = [];
  rows = []; failure = undefined;
  db.update.mockImplementation(table => {
    expect(table).toBe(sessions);
    return { set: (value: Record<string, unknown>) => {
      writes.push(value);
      return { where: (condition: SQL) => {
        record(condition);
        return { returning: async () => result() };
      } };
    } };
  });
  db.select.mockImplementation(() => ({ from: (table: unknown) => {
    expect(table).toBe(sessions);
    return { where: (condition: SQL) => {
      record(condition);
      return { orderBy: async (order: SQL) => {
        ordering.push(compile(order));
        return result();
      } };
    } };
  } }));
  db.delete.mockImplementation(table => {
    expect(table).toBe(sessions);
    return { where: (condition: SQL) => {
      record(condition);
      return { returning: async (projection: unknown) => {
        projections.push(projection);
        return result();
      } };
    } };
  });
});
afterEach(() => vi.useRealTimers());

describe("retention query construction — no database execution or simulated deletion", () => {
  it.each([0, 1, 3])("global purge returns the actual returned-row count %i", async count => {
    rows = Array.from({ length: count }, (_, i) =>
      fixture(OWNERS[i % 2], IDS[i % 2], new Date("2026-08-01T12:00:00Z")));
    expect(await storage.purgeExpiredDeletedSessions(CUTOFF)).toBe(count);
    expect(db.delete).toHaveBeenCalledExactlyOnceWith(sessions);
    expect(projections).toEqual([{ id: sessions.id }]);
    expect(predicates).toEqual([{
      sql: '("sessions"."deleted_at" is not null and "sessions"."deleted_at" < $1)',
      params: [CUTOFF.toISOString()],
    }]);
    // Exact compiled SQL proves no owner/activity-time predicate, no <= boundary.
    // It does NOT prove real database execution, deletion or idempotence.
    expect(NOW.getTime() - CUTOFF.getTime()).toBe(42 * 24 * 60 * 60 * 1000);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
  it("propagates the original purge database error, not a zero count", async () => {
    failure = new Error("SYNTHETIC_RETENTION_DB_SECRET_SENTINEL");
    await expect(storage.purgeExpiredDeletedSessions(CUTOFF)).rejects.toBe(failure);
    expect(predicates[0]).toEqual({
      sql: '("sessions"."deleted_at" is not null and "sessions"."deleted_at" < $1)',
      params: [CUTOFF.toISOString()],
    });
  });
  it.each(OWNERS.map((owner, i) => ({ owner, id: IDS[i] })))(
    "soft-delete compiles owner/id/active predicates for $owner and changes only deletion time",
    async ({ owner, id }) => {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
      const before = fixture(owner, id, null);
      rows = [{ ...before, deletedAt: NOW }];
      expect(await storage.softDeleteSession(owner, id)).toEqual({ ...before, deletedAt: NOW });
      scoped(owner, id, "null");
      expect(writes).toEqual([{ deletedAt: NOW }]);
      expect(db.delete).not.toHaveBeenCalled();
    },
  );
  it.each(OWNERS.map((owner, i) => ({ owner, id: IDS[i] })))(
    "restore compiles owner/id/deleted predicates for $owner, with no age gate",
    async ({ owner, id }) => {
      const before = fixture(owner, id, new Date("2020-01-01T00:00:00Z"));
      rows = [{ ...before, deletedAt: null }];
      expect(await storage.restoreSession(owner, id)).toEqual({ ...before, deletedAt: null });
      scoped(owner, id, "not null");
      expect(writes).toEqual([{ deletedAt: null }]);
      // Prior practice time/duration/notes/anomaly fields are not written.
      expect(db.delete).not.toHaveBeenCalled();
    },
  );
  it.each(["softDeleteSession", "restoreSession"] as const)(
    "%s returns undefined on no rows and propagates errors", async method => {
      expect(await storage[method](OWNERS[0], IDS[0])).toBeUndefined();
      failure = new Error("SYNTHETIC_RETENTION_WRITE_SECRET");
      await expect(storage[method](OWNERS[1], IDS[1])).rejects.toBe(failure);
      const state = method === "restoreSession" ? "not null" : "null";
      expect(predicates).toEqual(OWNERS.map((owner, i) => ({
        sql: `("sessions"."user_id" = $1 and "sessions"."id" = $2 and "sessions"."deleted_at" is ${state})`,
        params: [owner, IDS[i]],
      })));
    },
  );
  it.each(OWNERS)("Recently Deleted is owner scoped and ordered by deletion, not practice time: %s", async owner => {
    rows = [
      fixture(owner, IDS[0], new Date("2026-10-02T12:00:00Z")),
      fixture(owner, IDS[1], new Date("2026-08-01T12:00:00Z")),
    ];
    expect(await storage.getDeletedSessions(owner)).toEqual(rows);
    expect(predicates).toEqual([{
      sql: '("sessions"."user_id" = $1 and "sessions"."deleted_at" is not null)',
      params: [owner],
    }]);
    expect(ordering).toEqual([{ sql: '"sessions"."deleted_at" desc', params: [] }]);
  });
  it.each(OWNERS)("active listing excludes deletion and orders practice time: %s", async owner => {
    rows = [fixture(owner, IDS[0], null)];
    expect(await storage.getSessions(owner)).toEqual(rows);
    expect(predicates).toEqual([{
      sql: '("sessions"."user_id" = $1 and "sessions"."deleted_at" is null)',
      params: [owner],
    }]);
    expect(ordering).toEqual([{ sql: '"sessions"."timestamp" desc', params: [] }]);
  });
});