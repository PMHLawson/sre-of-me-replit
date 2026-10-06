import type { Pool, PoolClient } from "pg";
import { BoundaryError, createOrgContextResolver,
  type OwnershipDatabase, type OrgContext, type Transaction } from "./org-context";

type Request = Parameters<ReturnType<typeof createOrgContextResolver>>[0];
export interface BootstrapUnit {
  readonly actorUserId: string;
  readonly db: OwnershipDatabase;
  readonly tx: Transaction;
  /** Mint only from the original request, after a persisted membership exists. */
  resolveContext(): Promise<OrgContext>;
}
export function authenticatedBootstrapActor(request: Request): string {
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
 * Narrow server-only bootstrap seam: no environment or pool construction.
 * The persisted actor is locked BEFORE scanning/provisioning membership.
 * Ordinary 432 resolution is unchanged and still refuses missing membership.
 * Nested failures poison this unit; raw transaction control and expired handles
 * are refused. An ambiguous COMMIT destroys the checked-out client.
 */
export function createAuthenticatedBootstrapUnit(pool: Pick<Pool, "connect">) {
  if (!pool || typeof pool.connect !== "function") throw new BoundaryError(503);
  return Object.freeze({
    async run<T>(request: Request, operation: (unit: BootstrapUnit) => Promise<T>): Promise<T> {
      const actor = authenticatedBootstrapActor(request);
      if (typeof operation !== "function") throw new BoundaryError(400);
      let client: PoolClient | undefined;
      let began = false, committed = false, destroy = false, active = false, commitAttempted = false, failed = false;
      const pending: Promise<unknown>[] = [];
      const track = <V>(promise: Promise<V>) => {
        pending.push(promise); void promise.catch(() => { failed = true; }); return promise;
      };
      const refused = () => {
        const rejection = Promise.reject(new BoundaryError(503)); void rejection.catch(() => {}); return rejection;
      };
      const tx: Transaction = Object.freeze({
        query(sql: string, values: unknown[] = []) {
          if (!active) return refused();
          if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|LOCK)\b/i.test(sql) || sql.includes(";")) {
            failed = true; return track(refused());
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
      const unit: BootstrapUnit = Object.freeze({ actorUserId: actor, db, tx,
        resolveContext: () => {
          if (!active) return refused();
          return track(Promise.resolve().then(async () => {
            const context = await createOrgContextResolver(db)(request);
            if (context.actorUserId !== actor) throw new BoundaryError(401);
            return context;
          }));
        },
      });
      try {
        client = await pool.connect();
        await client.query("BEGIN"); began = true; active = true;
        const persisted = await tx.query("SELECT id FROM public.users WHERE id=$1 FOR UPDATE", [actor]);
        if (persisted.rows.length !== 1 || persisted.rows[0].id !== actor) throw new BoundaryError(403);
        const result = await operation(unit);
        active = false;
        await Promise.allSettled(pending);
        if (failed) throw new BoundaryError(503);
        commitAttempted = true;
        const commit = await client.query("COMMIT");
        if (commit.command !== "COMMIT") throw new BoundaryError(503);
        committed = true; return result;
      } catch (error) {
        active = false; await Promise.allSettled(pending);
        if (client && began && !committed) {
          try { await client.query("ROLLBACK"); } catch { destroy = true; }
        }
        if (client && ((!began) || (commitAttempted && !committed))) destroy = true;
        throw destroy ? new BoundaryError(503) : sanitized(error);
      } finally {
        active = false;
        if (client) { try { client.release(destroy); } catch { throw new BoundaryError(503); } }
      }
    },
  });
}
