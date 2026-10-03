import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStartupRetention } from "./startup-retention";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
// Independent calendar fixture, not computed from implementation constants.
const CUTOFF = "2026-08-22T12:00:00.000Z";
function fakeStorage() {
  const records = [
    { id: "invented-active", deletedAt: null },
    { id: "invented-expired", deletedAt: new Date("2026-08-21T12:00:00Z") },
    { id: "invented-boundary", deletedAt: new Date(CUTOFF) },
    { id: "invented-recent", deletedAt: new Date("2026-10-02T12:00:00Z") },
  ];
  const purgeExpiredDeletedSessions = vi.fn(async (cutoff: Date) => {
    let count = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      const deletedAt = records[i].deletedAt;
      if (deletedAt && deletedAt < cutoff) { records.splice(i, 1); count++; }
    }
    return count;
  });
  return { records, purgeExpiredDeletedSessions };
}

afterEach(() => vi.restoreAllMocks());

describe("startup activity preservation", () => {
  it.each([
    undefined, "", "false", "FALSE", "False", "0", "1", "yes", "on",
    "enabled", "TRUE", "True", " true", "true ", "true\n", "\ntrue",
    "true=true", "true,false", "null", "undefined",
  ])("preserves every fake record for opt-in %j", async (optIn) => {
    const storage = fakeStorage();
    const before = storage.records.map(row => ({ ...row }));
    const now = vi.fn(() => NOW), log = vi.fn(), reportError = vi.fn();
    const result = runStartupRetention({ optIn, storage, now, log, reportError });
    expect(result).toBeUndefined();
    await Promise.resolve();
    expect(storage.records).toEqual(before);
    expect(storage.purgeExpiredDeletedSessions).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("only explicit true invokes the independent forty-two-day cutoff", async () => {
    const storage = fakeStorage(), log = vi.fn(), reportError = vi.fn();
    const now = vi.fn(() => NOW);
    const result = runStartupRetention({ optIn: "true", storage, now, log, reportError });
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(now).toHaveBeenCalledOnce();
    expect(storage.purgeExpiredDeletedSessions).toHaveBeenCalledExactlyOnceWith(new Date(CUTOFF));
    expect(storage.records.map(row => row.id)).toEqual([
      "invented-active", "invented-boundary", "invented-recent",
    ]);
    expect(log).toHaveBeenCalledExactlyOnceWith("purged 1 soft-deleted session older than 42d", "retention");
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([0, 2])("retains plural success logging for %i rows", async (count) => {
    const storage = { purgeExpiredDeletedSessions: vi.fn(async () => count) }, log = vi.fn();
    await runStartupRetention({ optIn: "true", storage, now: () => NOW, log });
    expect(log).toHaveBeenCalledExactlyOnceWith(`purged ${count} soft-deleted sessions older than 42d`, "retention");
  });

  it("reports asynchronous errors without rejecting or altering fake records", async () => {
    const storage = fakeStorage(), before = [...storage.records], error = new Error("invented storage rejection");
    storage.purgeExpiredDeletedSessions.mockRejectedValueOnce(error);
    const log = vi.fn(), reportError = vi.fn();
    await expect(runStartupRetention({ optIn: "true", storage, now: () => NOW, log, reportError })).resolves.toBeUndefined();
    expect(storage.records).toEqual(before);
    expect(log).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledExactlyOnceWith("[retention] purgeExpiredDeletedSessions failed:", error);
  });

  it("keeps the existing console error sink and default real clock", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("invented default-sink rejection");
    const storage = { purgeExpiredDeletedSessions: vi.fn(async (_cutoff: Date) => { throw error; }) };
    await runStartupRetention({ optIn: "true", storage, log: vi.fn() });
    expect(clock).toHaveBeenCalledOnce();
    expect(storage.purgeExpiredDeletedSessions).toHaveBeenCalledExactlyOnceWith(new Date(CUTOFF));
    expect(sink).toHaveBeenCalledExactlyOnceWith("[retention] purgeExpiredDeletedSessions failed:", error);
  });

  it("preserves synchronous throw behavior rather than silently swallowing it", () => {
    const error = new Error("invented synchronous throw");
    const storage = { purgeExpiredDeletedSessions: (_cutoff: Date): Promise<number> => { throw error; } };
    expect(() => runStartupRetention({ optIn: "true", storage, now: () => NOW, log: vi.fn() })).toThrow(error);
  });

  it("wires the actual listen callback to the guard without executing the application", () => {
    const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const source = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const listen = calls.find(call => call.expression.getText(source) === "httpServer.listen");
    expect(listen).toBeDefined();
    const guards = calls.filter(call => call.expression.getText(source) === "runStartupRetention");
    expect(guards).toHaveLength(1);
    const guard = guards[0];
    expect(guard.pos).toBeGreaterThan(listen!.arguments[1].pos);
    expect(guard.end).toBeLessThanOrEqual(listen!.arguments[1].end);
    expect(guard.arguments[0].getText(source)).toMatch(/optIn:\s*process\.env\.SESSION_RETENTION_PURGE_ENABLED/);
    expect(guard.arguments[0].getText(source)).toMatch(/\bstorage\b/);
    expect(calls.filter(call => /purgeExpiredDeletedSessions/.test(call.expression.getText(source)))).toHaveLength(0);
    expect(text).toContain('import { runStartupRetention } from "./startup-retention"');
  });
});