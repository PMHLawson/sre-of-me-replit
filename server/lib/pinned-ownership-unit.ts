import type { Pool, PoolClient } from "pg";
import { BoundaryError, createOrgContextResolver,
  type OwnershipDatabase, type OrgContext, type Transaction } from "./org-context";

type Request = Parameters<ReturnType<typeof createOrgContextResolver>>[0];
export interface OwnershipUnit {
  readonly db: OwnershipDatabase;
  readonly tx: Transaction;
  readonly context: OrgContext;
}

function authenticatedActor(request: Request): string {
  try {
    const actor = (request?.user as { claims?: { sub?: unknown } } | undefined)?.claims?.sub;
    if (typeof request?.isAuthenticated !== "function" || request.isAuthenticated() !== true ||
      typeof actor !== "string" || !actor.length || actor.length > 200 || actor.trim() !== actor ||
      /[\u0000-\u001f\u007f]/.test(actor) || actor === "__proto__") throw 0;
    return actor;
  } catch { throw new BoundaryError(401); }
}
const sanitized = (error: unknown) => error instanceof BoundaryError ? error : new BoundaryError(503);

/**
 * Server-only synchronization seam. The caller injects an existing Pool; this
 * module neither reads environment settings nor opens/configures a pool.
 * Every nested repository operation uses one checked-out PostgreSQL client.
 * A caught nested failure poisons the entire unit, rather than allowing a
 * legacy write to commit without its canonical row or audit.
 * The callback must await its work. Handles expire when the callback returns.
 */
export function createPinnedOwnershipUnit(pool: Pick<Pool, "connect">) {
  if (!pool || typeof pool.connect !== "function") throw new BoundaryError(503);
  return Object.freeze({
    async run<T>(request: Request, operation: (unit: OwnershipUnit) => Promise<T>): Promise<T> {
      const actor = authenticatedActor(request); // malformed auth: zero connections/queries
      if (typeof operation !== "function") throw new BoundaryError(400);
      let client: PoolClient | undefined;
      let began = false, committed = false, destroy = false, active = false, commitAttempted = false;
      let failed = false;
      const pending: Promise<unknown>[] = [];
      const track = <V>(promise: Promise<V>) => {
        pending.push(promise);
        // Observe even an unawaited rejection, but preserve the caller's result.
        void promise.catch(() => { failed = true; });
        return promise;
      };
      const refused = () => {
        const rejection = Promise.reject(new BoundaryError(503));
        void rejection.catch(() => {});
        return rejection;
      };
      const tx: Transaction = Object.freeze({
        query(sql: string, values: unknown[] = []) {
          if (!active) return refused();
          // Narrow internal seam: one parameterized repository statement.
          // Transaction control stays private to this unit of work.
          if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|LOCK)\b/i.test(sql) || sql.includes(";")) {
            failed = true;
            return track(refused());
          }
          return track(Promise.resolve().then(() => client!.query(sql, values)));
        },
      });
      const db: OwnershipDatabase = Object.freeze({
        transaction<V>(nested: (transaction: Transaction) => Promise<V>): Promise<V> {
          if (!active) return refused();
          return track(Promise.resolve().then(() => nested(tx)));
        },
      });
      try {
        client = await pool.connect();
        await client.query("BEGIN"); began = true; active = true;
        // Pass the ORIGINAL Passport request, never a reconstructed principal.
        const context = await createOrgContextResolver(db)(request);
        if (context.actorUserId !== actor) throw new BoundaryError(401);
        const result = await operation(Object.freeze({ db, tx, context }));
        active = false;
        await Promise.allSettled(pending);
        if (failed) throw new BoundaryError(503);
        commitAttempted = true;
        const commit = await client.query("COMMIT");
        // PostgreSQL can answer an aborted transaction's COMMIT with ROLLBACK.
        if (commit.command !== "COMMIT") throw new BoundaryError(503);
        committed = true;
        return result;
      } catch (error) {
        active = false;
        await Promise.allSettled(pending);
        if (client && began && !committed) {
          try { await client.query("ROLLBACK"); }
          catch { destroy = true; }
        }
        // A failed/ambiguous COMMIT must never put its client back in circulation.
        if (client && ((!began) || (commitAttempted && !committed))) destroy = true;
        throw destroy ? new BoundaryError(503) : sanitized(error);
      } finally {
        active = false;
        if (client) {
          try { client.release(destroy); }
          catch { throw new BoundaryError(503); }
        }
      }
    },
  });
}
