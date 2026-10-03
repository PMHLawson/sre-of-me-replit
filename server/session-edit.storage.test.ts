import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sessions, sessionEdits, type Session } from "@shared/schema";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("./db", () => ({ db: mocks }));
import { DatabaseStorage } from "./storage";

const storage = new DatabaseStorage();
const dialect = new PgDialect();
let row: Session & { userId: string };
let audits: any[];
let failAt: "audit" | "update" | null;
let predicates: { sql: string; params: unknown[] }[];
beforeEach(() => {
  row = {
    id: "fixture-session", userId: "fixture-owner", domain: "music", durationMinutes: 30,
    timestamp: new Date("2026-09-20T12:00:00Z"), notes: "original fixture",
    deletedAt: null, isAnomaly: false, anomalyNote: null,
  };
  audits = [];
  predicates = [];
  failAt = null;
  mocks.transaction.mockReset();
  // Model only DB effects; the real storage method decides changes, prior values,
  // predicates and audit fields. Staging commits only on successful transaction.
  mocks.transaction.mockImplementation(async callback => {
    let stagedRow = structuredClone(row);
    const stagedAudits: any[] = [];
    function owned(condition: any) {
      const query = dialect.sqlToQuery(condition);
      predicates.push(query);
      return query.params[0] === stagedRow.userId && query.params[1] === stagedRow.id && !stagedRow.deletedAt;
    }
    const tx = {
      select: () => ({ from: (table: any) => {
        expect(table).toBe(sessions);
        return { where: async (condition: any) => owned(condition) ? [structuredClone(stagedRow)] : [] };
      } }),
      insert: (table: any) => {
        expect(table).toBe(sessionEdits);
        return { values: async (value: any) => {
          if (failAt === "audit") throw new Error("fixture audit failure");
          stagedAudits.push(structuredClone(value));
        } };
      },
      update: (table: any) => {
        expect(table).toBe(sessions);
        return { set: (value: any) => ({ where: (condition: any) => ({
          returning: async () => {
            if (failAt === "update") throw new Error("fixture update failure");
            if (!owned(condition)) return [];
            stagedRow = { ...stagedRow, ...value };
            return [structuredClone(stagedRow)];
          },
        }) }) };
      },
    };
    const result = await callback(tx);
    row = stagedRow;
    audits.push(...stagedAudits);
    return result;
  });
});

describe("session-edit persistence and audit", () => {
  it("persists flag/note and every changed field, auditing prior values and reason", async () => {
    const before = structuredClone(row);
    const result = await storage.updateSession(row.userId, row.id, {
      domain: "fitness", durationMinutes: 90, timestamp: "2026-09-21T12:00:00Z",
      notes: "new fixture", isAnomaly: true, anomalyNote: "intentional practice", reason: "fixture correction",
    });
    expect(result).toEqual(row);
    expect(row).toEqual({
      ...before, domain: "fitness", durationMinutes: 90, timestamp: new Date("2026-09-21T12:00:00Z"),
      notes: "new fixture", isAnomaly: true, anomalyNote: "intentional practice",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ sessionId: row.id, userId: row.userId, reason: "fixture correction" });
    expect(JSON.parse(audits[0].changedFields)).toEqual({
      domain: before.domain, durationMinutes: before.durationMinutes,
      timestamp: before.timestamp.toISOString(), notes: before.notes, isAnomaly: false, anomalyNote: null,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(predicates).toHaveLength(2);
    for (const predicate of predicates) {
      expect(predicate.params).toEqual([before.userId, before.id]);
      expect(predicate.sql).toContain('"user_id"');
      expect(predicate.sql).toContain('"id"');
      expect(predicate.sql).toContain('"deleted_at" is null');
    }
  });

  it("clears the old note when unflagged, even if a stale note is supplied", async () => {
    row.isAnomaly = true;
    row.anomalyNote = "prior explanation";
    await storage.updateSession(row.userId, row.id, {
      isAnomaly: false, anomalyNote: "stale submitted note", reason: "back to normal",
    });
    expect(row.isAnomaly).toBe(false);
    expect(row.anomalyNote).toBeNull();
    expect(JSON.parse(audits[0].changedFields)).toEqual({
      isAnomaly: true, anomalyNote: "prior explanation",
    });
    expect(audits[0].reason).toBe("back to normal");
  });

  it("ordinary partial edits preserve omitted fields, identity, flag and explanation", async () => {
    row.isAnomaly = true;
    row.anomalyNote = "prior explanation";
    const before = structuredClone(row);
    await storage.updateSession(row.userId, row.id, { notes: null, reason: "remove notes" });
    expect(row).toEqual({ ...before, notes: null });
    expect(JSON.parse(audits[0].changedFields)).toEqual({ notes: "original fixture" });
  });

  it("note-only edits retain the previous explanation in audit", async () => {
    row.isAnomaly = true;
    row.anomalyNote = "prior explanation";
    await storage.updateSession(row.userId, row.id, { anomalyNote: "corrected explanation", reason: "clarify" });
    expect(row.anomalyNote).toBe("corrected explanation");
    expect(JSON.parse(audits[0].changedFields)).toEqual({ anomalyNote: "prior explanation" });
  });

  it("no-op edits still retain a reason and empty changed-fields audit", async () => {
    const before = structuredClone(row);
    expect(await storage.updateSession(row.userId, row.id, { durationMinutes: 30, reason: "reviewed" })).toEqual(before);
    expect(row).toEqual(before);
    expect(audits).toEqual([{
      sessionId: row.id, userId: row.userId, reason: "reviewed", changedFields: "{}",
    }]);
  });

  it.each(["different-owner", "deleted-row", "missing-id"])(
    "does not update or audit %s",
    async mode => {
      if (mode === "deleted-row") row.deletedAt = new Date("2026-09-22T12:00:00Z");
      const before = structuredClone(row);
      const result = await storage.updateSession(
        mode === "different-owner" ? "another-owner" : row.userId,
        mode === "missing-id" ? "missing" : row.id,
        { isAnomaly: true, anomalyNote: "fixture", reason: "fixture" },
      );
      expect(result).toBeUndefined();
      expect(row).toEqual(before);
      expect(audits).toEqual([]);
    },
  );

  it.each(["audit", "update"] as const)("keeps data and audit unchanged on %s failure", async failure => {
    failAt = failure;
    const before = structuredClone(row);
    await expect(storage.updateSession(row.userId, row.id, {
      isAnomaly: true, anomalyNote: "fixture", reason: "fixture",
    })).rejects.toThrow(`fixture ${failure} failure`);
    expect(row).toEqual(before);
    expect(audits).toEqual([]);
  });
});