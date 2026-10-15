import { randomUUID } from "node:crypto";
import { assertContext, revalidate, BoundaryError, type OrgContext, type OwnershipDatabase, type Transaction } from "./org-context";

/**
 * Internal server service, not a request API. The repository supplies snapshots
 * actually returned by its scoped SQL. There is no actor/system override.
 * The injected transaction is the SAME handle that changed the entity.
 */
export function createAuditService(tx: Transaction, db: OwnershipDatabase, context: OrgContext) {
  assertContext(db, context);
  return Object.freeze({
    /**
     * Narrow legacy adapter: complete text stays inside PostgreSQL. The new
     * event is private to this transaction until both snapshots are complete.
     * No committed event can be edited through this service. Any stage, business
     * or finalization failure aborts the surrounding ownership transaction.
     */
    async captureLegacyDeviation<T>(id: string, action: "create" | "update" | "delete",
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
    },
    async append(entityType: string, identity: readonly string[], action: "create" | "update" | "delete",
      reason: string, before: unknown, after: unknown): Promise<void> {
      assertContext(db, context);
      if (!/^[a-z_][a-z0-9_]{0,63}$/.test(entityType) || !identity.length ||
          identity.some(x => typeof x !== "string" || !x.length || x.length > 200) ||
          !["create","update","delete"].includes(action) ||
          typeof reason !== "string" || !reason.trim() || reason.length > 500)
        throw new BoundaryError(400);
      // Serialize immediately, before awaiting SQL: callers cannot later mutate
      // persisted snapshots through references. PostgreSQL stores independent JSONB.
      const old = before === null ? null : JSON.stringify(before);
      const next = after === null ? null : JSON.stringify(after);
      await revalidate(tx,db,context);
      await tx.query(`INSERT INTO public.audit_events
        (audit_event_id,org_id,actor_kind,actor_user_id,entity_type,entity_id,action,occurred_at,reason,"before","after")
        VALUES ($1,$2,'user',$3,$4,$5,$6,clock_timestamp(),$7,$8::jsonb,$9::jsonb)`,
      [randomUUID(),context.orgId,context.actorUserId,entityType,JSON.stringify(identity),action,reason,old,next]);
    },
  });
}