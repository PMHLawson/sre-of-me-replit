import type { Pool, PoolClient, QueryConfig } from "pg";
import { performance } from "node:perf_hooks";
import { withTransactionReadBudget } from "./transaction-read-budget";
import { ResourceLimitError, READ_TIMEOUT_MS } from "./read-budget";
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
      const deadline=performance.now()+READ_TIMEOUT_MS*6;
      const nativeQuery=async(sql:string,values:unknown[]=[],cleanup=false)=>{
        const remaining=cleanup?READ_TIMEOUT_MS:Math.floor(deadline-performance.now());
        if(remaining<1)throw new ResourceLimitError();
        const config:QueryConfig & {query_timeout:number}={text:sql,values,query_timeout:Math.min(READ_TIMEOUT_MS,remaining)};
        try{return await client!.query(config);}catch(error){
          const code=String((error as {code?:unknown})?.code??"");
          if((error as Error)?.message==="Query read timeout"||!/^([0-9A-Z]{5})$/.test(code)||code.startsWith("08")||code==="57P01"){
            destroy=true;throw new ResourceLimitError();
          }
          if(["57014","55P03"].includes(code))throw new ResourceLimitError();
          throw error;
        }
      };
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
          return track(Promise.resolve().then(() => nativeQuery(sql, values)));
        },
      });
      let currentTx=tx;
      const db: OwnershipDatabase = Object.freeze({
        transaction<V>(nested: (transaction: Transaction) => Promise<V>): Promise<V> {
          if (!active) return refused();
          return track(Promise.resolve().then(() => nested(currentTx)));
        },
      });
      try {
        client = await pool.connect();
        await nativeQuery("BEGIN"); began = true; active = true;
        // Context, nested repositories and the caller share one allowance.
        const result=await withTransactionReadBudget(tx,async guardedTx=>{
          currentTx=guardedTx;
          // Pass the ORIGINAL Passport request, never a reconstructed principal.
          const context=await createOrgContextResolver(db)(request);
          if(context.actorUserId!==actor)throw new BoundaryError(401);
          const value=await operation(Object.freeze({db,tx:guardedTx,context}));
          // Await queued work before the shared guard expires. This preserves
          // the existing promise-drain/poisoning behavior for unawaited writes.
          await Promise.allSettled(pending);
          if(failed)throw new BoundaryError(503);
          return value;
        },deadline);
        active = false;
        await Promise.allSettled(pending);
        if (failed) throw new BoundaryError(503);
        commitAttempted = true;
        const commit = await nativeQuery("COMMIT");
        // PostgreSQL can answer an aborted transaction's COMMIT with ROLLBACK.
        if (commit.command !== "COMMIT") throw new BoundaryError(503);
        committed = true;
        return result;
      } catch (error) {
        active = false;
        await Promise.allSettled(pending);
        if (client && began && !committed && !destroy) {
          try { await nativeQuery("ROLLBACK",[],true); }
          catch { destroy = true; }
        }
        // A failed/ambiguous COMMIT must never put its client back in circulation.
        if (client && ((!began) || (commitAttempted && !committed))) destroy = true;
        throw error instanceof ResourceLimitError ? error : destroy ? new BoundaryError(503) : sanitized(error);
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
