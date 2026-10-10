import { Pool, type PoolConfig } from "pg";

/** pg-pool removes the failed idle client before emitting this event.
 * Never forward the error/client: even error properties can contain secrets.
 */
export function createDatabasePool(config: PoolConfig, report: (message: string) => void = console.error): Pool {
  const pool = new Pool(config);
  pool.on("error", () => {
    try { report("Database pool discarded a failed idle connection."); }
    catch { /* A reporting failure must not turn an idle disconnect into a crash. */ }
  });
  return pool;
}
