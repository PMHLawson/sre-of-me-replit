import { createHash } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import type { Pool, PoolClient } from "pg";
import { BoundaryError, type OwnershipDatabase, type Transaction } from "../lib/org-context";

export const adoptionPath = "/_internal/policy-v2-adoption";
export interface AdoptionConfig {
  readonly enabled: boolean;
  readonly origin?: string;
  readonly actorHash?: string;
  readonly expiresAt?: number;
  readonly binding?: Readonly<{ database: string; endpoint: string; role: string }>;
}
const unavailable = () => new BoundaryError(503);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Explicit, server-owned, short-lived Development maintenance configuration. */
export function readAdoptionConfig(env: Record<string, string | undefined>, now = Date.now()): AdoptionConfig {
  const flag = env.SOMR_POLICY_ADOPTION;
  if (flag === undefined || flag === "" || flag === "disabled") return Object.freeze({ enabled: false });
  if (flag !== "enabled" || env.NODE_ENV !== "development" ||
    ![undefined, "", "false", "0"].includes(env.REPLIT_DEPLOYMENT) ||
    env.SESSION_RETENTION_PURGE_ENABLED === "true" ||
    ![undefined, "", "disabled"].includes(env.SOMR_LEGACY_WRITE_THROUGH)) throw unavailable();
  const origin = env.SOMR_POLICY_ADOPTION_ORIGIN, actorHash = env.SOMR_POLICY_ADOPTION_ACTOR_SHA256;
  const expiry = env.SOMR_POLICY_ADOPTION_EXPIRES_AT;
  let url: URL;
  try { url = new URL(origin!); } catch { throw unavailable(); }
  if (!origin || origin.length > 300 || origin !== url.origin || url.protocol !== "https:" ||
    !url.hostname.endsWith(".replit.dev") || url.username || url.password || url.port ||
    !actorHash || !/^[a-f0-9]{64}$/.test(actorHash)) throw unavailable();
  const expiresAt = Date.parse(expiry ?? "");
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== expiry ||
    expiresAt <= now || expiresAt - now > 15 * 60_000) throw unavailable();
  const binding = { database: env.SOMR_POLICY_ADOPTION_DATABASE_MD5!,
    endpoint: env.SOMR_POLICY_ADOPTION_ENDPOINT_MD5!, role: env.SOMR_POLICY_ADOPTION_ROLE_MD5! };
  if (Object.values(binding).some(x => typeof x !== "string" || !/^[a-f0-9]{32}$/.test(x))) throw unavailable();
  return Object.freeze({ enabled: true, origin, actorHash, expiresAt, binding: Object.freeze(binding) });
}

export async function verifyAdoptionBinding(client: Pick<PoolClient, "query">, binding: NonNullable<AdoptionConfig["binding"]>) {
  const rows = (await client.query(`SELECT md5(current_database()) AS database,
    md5(coalesce(inet_server_addr()::text,'unix-socket')||':'||coalesce(inet_server_port()::text,'')) AS endpoint,
    md5(current_user) AS role`)).rows;
  if (rows.length !== 1 || !binding || ["database", "endpoint", "role"].some(k =>
    rows[0][k] !== binding[k as keyof typeof binding])) throw unavailable();
}

/** Pre-membership seed adapter: a checked-out client, bounded SQL, no legacy UPDATE/DELETE. */
export function createAdoptionDatabase(pool: Pick<Pool, "connect">, binding: NonNullable<AdoptionConfig["binding"]>): OwnershipDatabase {
  const expected = Object.freeze({ ...binding });
  return Object.freeze({ async transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    let began = false, committed = false, active = false, failed = false, destroy = false, commitAttempted = false;
    const pending: Promise<unknown>[] = [];
    const refused = () => { const p = Promise.reject(unavailable()); void p.catch(() => {}); return p; };
    const track = <V>(p: Promise<V>): Promise<V> => {
      pending.push(p); void p.catch(() => { failed = true; }); return p;
    };
    const tx: Transaction = Object.freeze({ query(sql: string, values: unknown[] = []) {
      if (!active) return refused();
      if (typeof sql !== "string" || sql.includes(";") ||
        (!/^\s*(SELECT|INSERT|LOCK)\b/i.test(sql) && sql !== "SET LOCAL TIME ZONE 'UTC'")) {
        failed = true; return track(refused());
      }
      return track(Promise.resolve().then(() => client!.query(sql, values)));
    } });
    try {
      if (typeof operation !== "function") throw new BoundaryError(400);
      client = await pool.connect(); await client.query("BEGIN"); began = true;
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      await verifyAdoptionBinding(client, expected);
      active = true;
      const result = await operation(tx);
      active = false; await Promise.allSettled(pending);
      if (failed) throw unavailable();
      commitAttempted = true;
      if ((await client.query("COMMIT")).command !== "COMMIT") throw unavailable();
      committed = true; return result;
    } catch (e) {
      active = false; await Promise.allSettled(pending);
      if (client && began && !committed) { try { await client.query("ROLLBACK"); } catch { destroy = true; } }
      if (client && (!began || (commitAttempted && !committed))) destroy = true;
      throw destroy || !(e instanceof BoundaryError) ? unavailable() : e;
    } finally {
      active = false;
      if (client) { try { client.release(destroy); } catch { throw unavailable(); } }
    }
  } });
}

export interface AdoptionServices {
  seed(request: Request): Promise<unknown>;
  import(request: Request): Promise<unknown>;
  reconcile(request: Request): Promise<{ clean: boolean; counts: Record<string, number> }>;
}
const page = (message = "Choose a maintenance operation. Historical records are preserved.") =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Development policy adoption</title>
  <h1>Development policy adoption</h1><p>${message}</p>
  ${["seed", "import", "reconcile"].map(action => `<form method="post" action="${adoptionPath}/${action}">
  <button type="submit">${action}</button></form>`).join("")}</html>`;

/** Mount only in the temporary launcher, AFTER the original Passport/session middleware. */
export function mountDevelopmentAdoption(app: Express, options: {
  config: AdoptionConfig; authenticate: RequestHandler; getServices: () => Promise<AdoptionServices>; now?: () => number;
}) {
  const { config: input, authenticate, getServices } = options;
  const config = Object.freeze({ ...input, binding: input.binding && Object.freeze({ ...input.binding }) });
  if (!config.enabled) return;
  const now = options.now ?? Date.now;
  let services: Promise<AdoptionServices> | undefined;
  let busy = false;
  const guard: RequestHandler = (req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" });
    try {
      if (!config.origin || !config.actorHash || !config.expiresAt || now() >= config.expiresAt) throw unavailable();
      // Match the same trusted-proxy hostname used by the existing OAuth strategy.
      if (req.protocol !== "https" || req.hostname !== new URL(config.origin).hostname) throw new BoundaryError(403);
      const actor = (req.user as any)?.claims?.sub;
      if (req.isAuthenticated?.() !== true || typeof actor !== "string" || !actor.length || actor.length > 200 ||
        actor.trim() !== actor || /[\u0000-\u001f\u007f]/.test(actor) || actor === "__proto__") throw new BoundaryError(401);
      if (hash(actor) !== config.actorHash) throw new BoundaryError(403);
      for (const value of [req.body, req.query, req.params]) {
        if (value != null && (typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length))
          throw new BoundaryError(400);
      }
      if (req.method === "POST" && (req.get("origin") !== config.origin || req.get("sec-fetch-site") !== "same-origin"))
        throw new BoundaryError(403);
      next();
    } catch (error) {
      const e = error instanceof BoundaryError ? error : unavailable(); res.status(e.status).type("text").send(e.message);
    }
  };
  app.get(adoptionPath, authenticate, guard, (_req, res) => { res.type("html").send(page()); });
  for (const action of ["seed", "import", "reconcile"] as const) app.post(adoptionPath + "/" + action,
    authenticate, guard, (req, res) => {
      if (busy) { res.status(503).type("text").send("Service unavailable"); return; }
      busy = true;
      void (async () => {
        try {
          services ??= Promise.resolve().then(getServices);
          const service = await services;
          if (now() >= config.expiresAt!) throw unavailable();
          // The original authenticated request object is passed unchanged.
          const result = await service[action](req);
          if (action === "reconcile" && (result as any)?.clean !== true) throw unavailable();
          // Never render source mappings, identities, notes, database details or private errors.
          res.type("html").send(page(action + " completed successfully."));
        } catch (error) {
          const e = error instanceof BoundaryError ? error : unavailable(); res.status(e.status).type("text").send(e.message);
        } finally { busy = false; }
      })();
    });
}

export async function prepareAdoptionServices(pool: Pool, config: AdoptionConfig): Promise<AdoptionServices> {
  if (!config.enabled || !config.binding || !config.expiresAt || Date.now() >= config.expiresAt) throw unavailable();
  const db = createAdoptionDatabase(pool, config.binding);
  await db.transaction(async () => undefined); // Bind even the collection-only request before using its service.
  const [{ seedPolicyV2 }, { importLegacyObservations }, { createPinnedOwnershipUnit }, { createLegacyActivityMutations }] =
    await Promise.all([import("../lib/seed-policy-v2"), import("./legacy-observation-sync"),
      import("../lib/pinned-ownership-unit"), import("./legacy-activity-mutations")]);
  const collection = createLegacyActivityMutations(createPinnedOwnershipUnit(pool));
  return Object.freeze({ seed: (request: Request) => seedPolicyV2(db, request),
    import: (request: Request) => importLegacyObservations(db, request),
    reconcile: (request: Request) => collection.reconcile(request) });
}
