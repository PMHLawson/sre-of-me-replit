import { randomUUID } from "node:crypto";
import { z } from "zod";
import { insertDeviationSchema, updateDeviationSchema, deviationLifecycleSchema, deviationChangeReasonSchema,
  type Deviation } from "../../shared/schema";
import { authenticatedBootstrapActor, type BootstrapUnit, type createAuthenticatedBootstrapUnit } from "../lib/authenticated-bootstrap-unit";
import { captureLegacyDeviationChange } from "../lib/legacy-deviation-audit";
import { BoundaryError, type Transaction } from "../lib/org-context";
import { withOwnerWriteBudget } from "../lib/write-resource-budget";
import { readComplete } from "../lib/transaction-read-budget";
import { ensurePersonalWorkspaceContext } from "./personal-workspace-service";

type Units = ReturnType<typeof createAuthenticatedBootstrapUnit>;
type Request = Parameters<Units["run"]>[0];
const identity = z.string().min(1).max(200);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new BoundaryError(400); return result.data;
}
const columns = 'd.id,d.user_id AS "userId",d.domain,d.start_at AS "startAt",d.end_at AS "endAt",' +
  'd.ended_at AS "endedAt",d.deleted_at AS "deletedAt",d.exclude_from_composite AS "excludeFromComposite",' +
  '\'\'::text AS reason,d.reason IS NOT NULL AS "hasReason",COALESCE(octet_length(d.reason),0) AS "reasonBytes",' +
  'CASE WHEN d.reason IS NULL THEN \'absent\' ELSE \'not_loaded\' END AS "reasonAvailability"';
const fields = ["id","userId","domain","startAt","endAt","endedAt","deletedAt","excludeFromComposite","reason",
  "hasReason","reasonBytes","reasonAvailability"];
async function selected(tx: Transaction, actor: string, id: string, condition = "d.deleted_at IS NULL",
  input: {reason?: string; startAt?: string; endAt?: string|null} = {}) {
  const values: unknown[] = [actor,id], comparisons: string[] = [], extraFields: string[] = [];
  if (input.reason !== undefined) {
    const at = values.length+1; values.push(input.reason);
    let mayShorten = "false";
    if (!insertDeviationSchema.shape.reason.safeParse(input.reason).success) {
      const units = values.length+1, bytes = units+1;
      values.push(input.reason.length,new TextEncoder().encode(input.reason).byteLength);
      const oldUnits = "(char_length(d.reason)+char_length(regexp_replace(d.reason,'[^𐀀-􏿿]+','','g')))";
      // Exact retries need no Unicode recount. A new bounded reason needs no
      // grandfathering check at all. For an overlong replacement, cheap byte
      // and codepoint bounds prove obvious shortening before the exact UTF16
      // fallback. Group BMP runs rather than replacing one match per character.
      mayShorten = "CASE WHEN d.reason IS NOT DISTINCT FROM $"+at+"::text THEN false " +
        "WHEN $"+bytes+"::int > octet_length(d.reason) THEN false " +
        "WHEN $"+units+"::int < char_length(d.reason) THEN true " +
        "WHEN $"+units+"::int <= char_length(d.reason) AND $"+bytes+"::int < octet_length(d.reason) THEN true " +
        "ELSE CASE WHEN $"+bytes+"::int < octet_length(d.reason) THEN $"+units+"::int <= "+oldUnits+
        " ELSE $"+units+"::int < "+oldUnits+" END END";
    }
    comparisons.push('d.reason IS NOT DISTINCT FROM $'+at+'::text AS "reasonSame"',
      mayShorten+' AS "reasonMayShorten"');
    extraFields.push("reasonSame","reasonMayShorten");
  }
  // Compare in PostgreSQL under the owned row lock. JS Date milliseconds lose
  // legitimate microsecond changes and cannot decide whether a write is a no-op.
  for (const [key,column] of [["startAt","start_at"],["endAt","end_at"]] as const) {
    if (input[key] === undefined) continue;
    const at = values.length+1; values.push(input[key]);
    comparisons.push('d.'+column+' IS DISTINCT FROM $'+at+'::timestamptz AS "'+key+'Different"');
    extraFields.push(key+"Different");
  }
  const rows = await readComplete(tx, "SELECT " + columns + (comparisons.length ? ","+comparisons.join(",") : "") +
    " FROM public.deviations d WHERE d.user_id=$1 AND d.id=$2 AND " + condition + " LIMIT 2 FOR UPDATE",
    values,[...fields,...extraFields],1);
  return rows[0] as Deviation & Record<string, any> | undefined;
}
function summary(row: Deviation & Record<string, any>) {
  const { reasonSame, reasonMayShorten, startAtDifferent, endAtDifferent, ...value } = row;
  return value as Deviation;
}
async function ready(unit: BootstrapUnit, admitMutation: () => Promise<void>) {
  await admitMutation();
  return ensurePersonalWorkspaceContext(unit, admitMutation);
}
/** The actual original-user deviation writer; no scoring/canonical conversion.
 * Server actor, private-workspace bootstrap, rate charge, old/new SQL snapshots
 * and business mutation share one pinned authenticated transaction.
 */
export function createLegacyDeviationMutations(units: Units) {
  if (!units || typeof units.run !== "function") throw new BoundaryError(503);
  return Object.freeze({
    create: async (request: Request, input: unknown): Promise<Deviation> => {
      authenticatedBootstrapActor(request);
      const p = parse(insertDeviationSchema, input);
      return units.run(request, unit => withOwnerWriteBudget(unit.tx,unit.actorUserId,async ({admitMutation}) => {
        await unit.tx.query("SELECT set_config('TimeZone','UTC',true)");
        const context = await ready(unit,admitMutation), id = randomUUID();
        return captureLegacyDeviationChange(unit.tx,unit.db,context,id,"create",p.reason,async () => {
          const inserted = await unit.tx.query("INSERT INTO public.deviations(id,user_id,domain,reason,start_at,end_at,exclude_from_composite) " +
            "VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
            [id,unit.actorUserId,p.domain,p.reason,p.startAt,p.endAt??null,p.excludeFromComposite??true]);
          if (inserted.rows.length !== 1 || inserted.rows[0].id !== id) throw new BoundaryError(503);
          const after = await selected(unit.tx,unit.actorUserId,id);
          if (!after) throw new BoundaryError(503); return summary(after);
        });
      }));
    },
    edit: async (request: Request, key: unknown, input: unknown): Promise<Deviation | undefined> => {
      authenticatedBootstrapActor(request);
      const id = parse(identity,key), p = parse(updateDeviationSchema,input);
      return units.run(request, unit => withOwnerWriteBudget(unit.tx,unit.actorUserId,async ({admitMutation}) => {
        await unit.tx.query("SELECT set_config('TimeZone','UTC',true)");
        const before = await selected(unit.tx,unit.actorUserId,id,"d.deleted_at IS NULL",p);
        if (!before) return undefined;
        const changed: Record<string, unknown> = {};
        if (p.reason !== undefined && !before.reasonSame) {
          if (!insertDeviationSchema.shape.reason.safeParse(p.reason).success && !before.reasonMayShorten) throw new BoundaryError(400);
          changed.reason = p.reason;
        }
        if (p.startAt !== undefined && before.startAtDifferent) changed.start_at = p.startAt;
        if (p.endAt !== undefined && before.endAtDifferent) changed.end_at = p.endAt;
        if (p.excludeFromComposite !== undefined && p.excludeFromComposite !== before.excludeFromComposite) changed.exclude_from_composite = p.excludeFromComposite;
        const names = Object.keys(changed);
        if (!names.length) return summary(before); // no bootstrap, audit or charge
        const reason = parse(deviationChangeReasonSchema,p.changeReason), context = await ready(unit,admitMutation);
        return captureLegacyDeviationChange(unit.tx,unit.db,context,id,"update",reason,async () => {
          const assignments = names.map((name,index) => name+"=$"+(index+3));
          const updated = await unit.tx.query("UPDATE public.deviations SET "+assignments.join(",")+
            " WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id",
            [unit.actorUserId,id,...Object.values(changed)]);
          if (updated.rows.length !== 1 || updated.rows[0].id !== id) throw new BoundaryError(503);
          const after = await selected(unit.tx,unit.actorUserId,id);
          if (!after) throw new BoundaryError(503); return summary(after);
        });
      }));
    },
    end: async (request: Request, key: unknown, input: unknown): Promise<Deviation | undefined> => {
      authenticatedBootstrapActor(request);
      const id = parse(identity,key), p = parse(deviationLifecycleSchema,input??{});
      return units.run(request, unit => withOwnerWriteBudget(unit.tx,unit.actorUserId,async ({admitMutation}) => {
        await unit.tx.query("SELECT set_config('TimeZone','UTC',true)");
        const before = await selected(unit.tx,unit.actorUserId,id,"d.deleted_at IS NULL AND d.ended_at IS NULL");
        if (!before) return undefined;
        const reason = parse(deviationChangeReasonSchema,p.changeReason), context = await ready(unit,admitMutation);
        return captureLegacyDeviationChange(unit.tx,unit.db,context,id,"update",reason,async () => {
          const changed = await unit.tx.query("UPDATE public.deviations SET ended_at=clock_timestamp() " +
            "WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL AND ended_at IS NULL RETURNING id",[unit.actorUserId,id]);
          if (changed.rows.length !== 1 || changed.rows[0].id !== id) throw new BoundaryError(503);
          const after = await selected(unit.tx,unit.actorUserId,id);
          if (!after) throw new BoundaryError(503); return summary(after);
        });
      }));
    },
    softDelete: async (request: Request, key: unknown, input: unknown): Promise<Deviation | undefined> => {
      authenticatedBootstrapActor(request);
      const id = parse(identity,key), p = parse(deviationLifecycleSchema,input??{});
      return units.run(request, unit => withOwnerWriteBudget(unit.tx,unit.actorUserId,async ({admitMutation}) => {
        await unit.tx.query("SELECT set_config('TimeZone','UTC',true)");
        const before = await selected(unit.tx,unit.actorUserId,id);
        if (!before) return undefined;
        const reason = parse(deviationChangeReasonSchema,p.changeReason), context = await ready(unit,admitMutation);
        return captureLegacyDeviationChange(unit.tx,unit.db,context,id,"delete",reason,async () => {
          const changed = await unit.tx.query("UPDATE public.deviations SET deleted_at=clock_timestamp() " +
            "WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id",[unit.actorUserId,id]);
          if (changed.rows.length !== 1 || changed.rows[0].id !== id) throw new BoundaryError(503);
          const after = await selected(unit.tx,unit.actorUserId,id,"TRUE");
          if (!after) throw new BoundaryError(503); return summary(after);
        });
      }));
    },
  });
}
