import type { RequestHandler } from "express";

/** Server-injected dependencies only. This module never opens a connection. */
export interface Transaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface OwnershipDatabase {
  transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T>;
}
export class BoundaryError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 503) {
    super(({400:"Invalid request",401:"Authentication required",403:"Access denied",404:"Not found",503:"Service unavailable"})[status]);
  }
}
export interface OrgContext {
  readonly orgId: string;
  readonly actorUserId: string;
  readonly role: "owner" | "member";
  readonly rolloutMode: "legacy" | "shadow" | "v2";
}
const capabilities = new WeakMap<object, { db: OwnershipDatabase; membership: string }>();
const opaqueId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200 && v.trim() === v &&
  !/[\u0000-\u001f\u007f]/.test(v) && v !== "__proto__";

export function assertContext(db: OwnershipDatabase, context: OrgContext): void {
  if (!context || typeof context !== "object" || capabilities.get(context)?.db !== db)
    throw new BoundaryError(403);
}
export async function bounded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError(503); }
}
async function membership(tx: Transaction, actor: string) {
  // Lock the actor row before scanning ALL memberships. This also blocks a new
  // FK-backed membership for the actor while an authorized operation commits.
  const user = await tx.query("SELECT id FROM public.users WHERE id=$1 FOR UPDATE", [actor]);
  if (user.rows.length !== 1) throw new BoundaryError(403);
  const memberships = await tx.query(
    "SELECT org_id,user_id,role,created_at,updated_at FROM public.organization_members WHERE user_id=$1 ORDER BY org_id FOR SHARE", [actor]);
  if (memberships.rows.length !== 1) throw new BoundaryError(403);
  const m = memberships.rows[0];
  if (!opaqueId(m.org_id) || m.user_id !== actor || !["owner","member"].includes(m.role)) throw new BoundaryError(403);
  const organizations = await tx.query(
    "SELECT org_id,rollout_mode FROM public.organizations WHERE org_id=$1 FOR SHARE", [m.org_id]);
  if (organizations.rows.length !== 1 || !["legacy","shadow","v2"].includes(organizations.rows[0].rollout_mode))
    throw new BoundaryError(403);
  return { value: { orgId: m.org_id, actorUserId: actor, role: m.role, rolloutMode: organizations.rows[0].rollout_mode } as OrgContext,
    signature: JSON.stringify([m,organizations.rows[0]]) };
}
/** Call inside the same transaction as every repository read or mutation. */
export async function revalidate(tx: Transaction, db: OwnershipDatabase, context: OrgContext): Promise<void> {
  assertContext(db, context);
  const current = await membership(tx, context.actorUserId);
  if (current.signature !== capabilities.get(context)!.membership) throw new BoundaryError(403);
}
export function createOrgContextResolver(db: OwnershipDatabase) {
  if (!db || typeof db.transaction !== "function") throw new BoundaryError(503);
  return async (request: { isAuthenticated?: () => boolean; user?: unknown }): Promise<OrgContext> => {
    // Neither claims supplied outside the Passport user nor any request
    // body/header/query/path identifier is consulted.
    const actor = (request.user as { claims?: { sub?: unknown } } | undefined)?.claims?.sub;
    if (request.isAuthenticated?.() !== true || !opaqueId(actor)) throw new BoundaryError(401);
    return bounded(() => db.transaction(async tx => {
      const m = await membership(tx, actor);
      const context = Object.freeze(m.value);
      capabilities.set(context, { db, membership: m.signature });
      return context;
    }));
  };
}
/** Future seam only: mount AFTER the existing authentication guard. No routes here. */
export function createOrgContextMiddleware(db: OwnershipDatabase): RequestHandler {
  const resolve = createOrgContextResolver(db);
  return (req, res, next) => {
    void resolve(req).then(context => { res.locals.orgContext = context; next(); })
      .catch(error => { const e = error instanceof BoundaryError ? error : new BoundaryError(503); res.status(e.status).json({ message: e.message }); });
  };
}