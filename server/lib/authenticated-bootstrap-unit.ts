import type { Pool, PoolClient, QueryConfig } from "pg";
import { performance } from "node:perf_hooks";
import { withTransactionReadBudget } from "./transaction-read-budget";
import { ResourceLimitError, READ_TIMEOUT_MS } from "./read-budget";
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
      const deadline=performance.now()+READ_TIMEOUT_MS*6;
      const nativeQuery=async(sql:string,values:unknown[]=[],cleanup=false)=>{
        const remaining=cleanup?READ_TIMEOUT_MS:Math.floor(deadline-performance.now());
        if(remaining<1)throw new ResourceLimitError();
        const config:QueryConfig & {query_timeout:number}={text:sql,values,query_timeout:Math.min(READ_TIMEOUT_MS,remaining)};
        try{return await client!.query(config);}catch(error){
          const code=String((error as {code?:unknown})?.code??"");
          if((error as Error)?.message==="Query read timeout"){destroy=true;throw new ResourceLimitError();}
          if(!/^([0-9A-Z]{5})$/.test(code)||code.startsWith("08")||code==="57P01"){
            destroy=true;throw new BoundaryError(503);
          }
          if(["57014","55P03"].includes(code))throw new ResourceLimitError();
          throw error;
        }
      };
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
        const result=await withTransactionReadBudget(tx,async guardedTx=>{
          currentTx=guardedTx;
          const persisted=await guardedTx.query("SELECT id FROM public.users WHERE id=$1 FOR UPDATE",[actor]);
          if(persisted.rows.length!==1||persisted.rows[0].id!==actor)throw new BoundaryError(403);
          const unit: BootstrapUnit = Object.freeze({ actorUserId: actor, db, tx:guardedTx,
            resolveContext: () => {
              if (!active) return refused();
              return track(Promise.resolve().then(async () => {
                const context = await createOrgContextResolver(db)(request);
                if (context.actorUserId !== actor) throw new BoundaryError(401);
                return context;
              }));
            },
          });

          const value=await operation(unit);
          await Promise.allSettled(pending);
          if(failed)throw new BoundaryError(503);
          return value;
        },deadline);
        active=false;
        await Promise.allSettled(pending);
        if(failed)throw new BoundaryError(503);
        commitAttempted=true;
        const commit=await nativeQuery("COMMIT");
        if (commit.command !== "COMMIT") throw new BoundaryError(503);
        committed = true; return result;
      } catch (error) {
        active = false; await Promise.allSettled(pending);
        if (client && began && !committed && !destroy) {
          try { await nativeQuery("ROLLBACK",[],true); } catch { destroy = true; }
        }
        if (client && ((!began) || (commitAttempted && !committed))) destroy = true;
        throw error instanceof ResourceLimitError ? error : destroy ? new BoundaryError(503) : sanitized(error);
      } finally {
        active = false;
        if (client) { try { client.release(destroy); } catch { throw new BoundaryError(503); } }
      }
    },
  });
}
