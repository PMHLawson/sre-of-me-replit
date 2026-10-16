import { randomUUID } from "node:crypto";
import { assertContext, revalidate, BoundaryError, type OrgContext, type OwnershipDatabase, type Transaction } from "./org-context";

/** Narrow server-only legacy adapter; the generic audit service stays append-only.
 * Complete text stays inside PostgreSQL. The newly staged event can finalize
 * only within this call/transaction using its freshly generated event ID.
 * Any semantic, callback or SQL failure poisons that same transaction, so an
 * incomplete event cannot commit even when an internal caller catches an error.
 */
export async function captureLegacyDeviationChange<T>(
  tx: Transaction, db: OwnershipDatabase, context: OrgContext, id: string, action: "create" | "update" | "delete",
  reason: string, operation: () => Promise<T>): Promise<T> {
  try {
    assertContext(db, context);
    if (typeof id !== "string" || !id.length || id.length > 200 ||
        !["create","update","delete"].includes(action) || typeof operation !== "function" ||
        typeof reason !== "string" || !reason.trim() || reason.length > 500)
      throw new BoundaryError(400);
    await revalidate(tx, db, context);
    const eventId = randomUUID(), identity = JSON.stringify([id]);
    const values = [eventId, context.orgId, context.actorUserId, id, identity, action, reason];
    const staged = await tx.query(action === "create"
      ? "INSERT INTO public.audit_events " +
        "(audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,\"before\",\"after\") " +
        "SELECT $1,$2,'user',$3,'legacy_deviation',$5,$6,clock_timestamp(),$7,NULL,NULL " +
        "WHERE NOT EXISTS (SELECT 1 FROM public.deviations WHERE id=$4) RETURNING audit_event_id"
      : "INSERT INTO public.audit_events " +
        "(audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,\"before\",\"after\") " +
        "SELECT $1,$2,'user',$3,'legacy_deviation',$5,$6,clock_timestamp(),$7,to_jsonb(d),NULL " +
        "FROM public.deviations d WHERE d.user_id=$3 AND d.id=$4 AND d.deleted_at IS NULL RETURNING audit_event_id", values);
    if (staged.rows.length !== 1 || staged.rows[0].audit_event_id !== eventId) throw new BoundaryError(503);
    const result = await operation();
    await revalidate(tx, db, context);
    const finished = await tx.query("UPDATE public.audit_events a SET \"after\"=to_jsonb(d) FROM public.deviations d " +
      "WHERE a.audit_event_id=$1 AND a.org_id=$2 AND a.actor_kind='user' AND a.actor_user_id=$3 " +
      "AND a.entity_type='legacy_deviation' AND a.entity_id=$5 AND a.action=$6 AND a.\"after\" IS NULL " +
      "AND d.user_id=$3 AND d.id=$4 RETURNING a.audit_event_id", values.slice(0,6));
    if (finished.rows.length !== 1 || finished.rows[0].audit_event_id !== eventId) throw new BoundaryError(503);
    return result;
  } catch (error) {
    // Also poison on a semantic/caught callback failure, not only SQL errors.
    try { await tx.query("SELECT CAST('legacy deviation audit rejected' AS integer)"); } catch {}
    throw error;
  }
}
