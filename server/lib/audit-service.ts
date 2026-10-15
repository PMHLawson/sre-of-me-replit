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