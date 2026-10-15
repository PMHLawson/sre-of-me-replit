import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { runStartupRetention } from "./startup-retention";

function fakeStorage() {
  const records = [
    { id: "invented-active-2020", deletedAt: null, notes: "exact old practice" },
    { id: "invented-deleted-2020", deletedAt: new Date("2020-01-02T00:00:00Z"), notes: "restorable old note" },
    { id: "invented-deleted-2026", deletedAt: new Date("2026-10-02T00:00:00Z"), notes: "recent note" },
  ];
  const purgeExpiredDeletedSessions = vi.fn(async (_cutoff: Date) => {
    records.splice(0, records.length);
    throw new Error("Obsolete purge must never execute");
  });
  return { records, purgeExpiredDeletedSessions };
}

describe("startup historical-data preservation", () => {
  it.each([
    undefined, "", "false", "FALSE", "False", "0", "1", "yes", "on",
    "enabled", "TRUE", "True", " true", "true ", "true\n", "\ntrue",
    "true=true", "true,false", "null", "undefined", "true",
  ])("preserves every record for retired flag %j, including the old exact opt-in", async optIn => {
    const storage = fakeStorage(), before = structuredClone(storage.records);
    const now = vi.fn(() => Date.parse("2099-01-01T00:00:00Z"));
    const log = vi.fn(), reportError = vi.fn();
    expect(runStartupRetention({ optIn, storage, now, log, reportError })).toBeUndefined();
    await Promise.resolve();
    expect(storage.records).toEqual(before);
    expect(storage.purgeExpiredDeletedSessions).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    if (optIn === "true") expect(log).toHaveBeenCalledExactlyOnceWith(
      "SESSION_RETENTION_PURGE_ENABLED is retired and ignored; historical data is preserved.", "retention");
    else expect(log).not.toHaveBeenCalled();
  });

  it("does not even access an injected storage dependency when the old flag is true", () => {
    const access = vi.fn(() => { throw new Error("Storage access forbidden"); });
    const storage = new Proxy({} as { purgeExpiredDeletedSessions(cutoff: Date): Promise<number> }, { get: access });
    runStartupRetention({ optIn: "true", storage, log: vi.fn() });
    expect(access).not.toHaveBeenCalled();
  });

  it("wires startup only to the preservation notice without executing the application", () => {
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
    const argument = guard.arguments[0];
    expect(ts.isObjectLiteralExpression(argument)).toBe(true);
    if (ts.isObjectLiteralExpression(argument)) {
      expect(argument.properties.map(property => property.name?.getText(source))).toEqual(["optIn", "log"]);
    }
    expect(calls.filter(call => /purgeExpiredDeletedSessions/.test(call.expression.getText(source)))).toHaveLength(0);
    expect(text).toContain('import { runStartupRetention } from "./startup-retention"');
  });
});
