import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hook = fileURLToPath(new URL("../scripts/post-merge.sh", import.meta.url));
function withStub(action: (directory: string, audit: string) => void) {
  const directory = mkdtempSync(path.join(tmpdir(), "somr459-hook-"));
  const ownership = lstatSync(directory);
  const audit = path.join(directory, "invented-arguments.log");
  try {
    writeFileSync(path.join(directory, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_AUDIT"
if [ "$1" != install ]; then exit 91; fi
exit "$STUB_EXIT"
`, { mode: 0o700 });
    action(directory, audit);
  } finally {
    const current = lstatSync(directory);
    if (current.ino !== ownership.ino || current.dev !== ownership.dev || current.isSymbolicLink()) {
      throw new Error("STOP: owned stub directory identity changed; cleanup refused");
    }
    rmSync(directory, { recursive: true });
  }
}

describe("ordinary post-merge activity preserves the database", () => {
  it.each([undefined, "false", "true", "TRUE"])("installs dependencies only, irrespective of retention opt-in %j", (optIn) => {
    withStub((directory, audit) => {
      execFileSync("/bin/bash", [hook], {
        cwd: path.dirname(path.dirname(hook)),
        // Only the invented npm is reachable, never the real package tool.
        env: { PATH: directory, STUB_AUDIT: audit, STUB_EXIT: "0",
          ...(optIn === undefined ? {} : { SESSION_RETENTION_PURGE_ENABLED: optIn }) },
        timeout: 5000,
      });
      expect(readFileSync(audit, "utf8")).toBe("install --no-audit --no-fund\n");
    });
  });

  it("retains set -e installation failure behavior with no later database command", () => {
    withStub((directory, audit) => {
      let status: number | undefined;
      try {
        execFileSync("/bin/bash", [hook], {
          env: { PATH: directory, STUB_AUDIT: audit, STUB_EXIT: "23" },
          timeout: 5000, stdio: "pipe",
        });
      } catch (error) { status = (error as { status?: number }).status; }
      expect(status).toBe(23);
      expect(readFileSync(audit, "utf8")).toBe("install --no-audit --no-fund\n");
    });
  });

  it("leaves separately invoked schema tooling unchanged", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["db:push"]).toBe("drizzle-kit push");
  });
});