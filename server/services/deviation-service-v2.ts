import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BoundaryError } from "../lib/org-context";
import { createPinnedOwnershipUnit } from "../lib/pinned-ownership-unit";
import { createPolicyV2Storage } from "../storage/policy-v2-storage";

type Unit = ReturnType<typeof createPinnedOwnershipUnit>;
type Request = Parameters<Unit["run"]>[0];
type Store = ReturnType<typeof createPolicyV2Storage>;

const id = z.string().min(1).max(200).refine(value =>
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && value !== "__proto__");
const instant = z.string().datetime({ offset: true });
const reason = z.string().trim().min(1).max(500);
const practiceIdsSchema = z.array(id).min(1).max(100)
  .refine(values => new Set(values).size === values.length);
const createInput = z.object({
  startAt: instant,
  endAt: instant.nullable(),
  reason,
  changeReason: reason,
  practiceIds: practiceIdsSchema,
  type: z.enum(["stitch", "substitute_target"]),
}).strict().refine(value => value.endAt === null || Date.parse(value.endAt) > Date.parse(value.startAt));
const editInput = z.object({
  startAt: instant,
  endAt: instant.nullable(),
  reason,
  changeReason: reason,
  practiceIds: practiceIdsSchema,
}).strict().refine(value => value.endAt === null || Date.parse(value.endAt) > Date.parse(value.startAt));
const lifecycleInput = z.object({ changeReason: reason }).strict();

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BoundaryError(400);
  return result.data;
}
function normalizedIds(values: string[]) {
  return values.slice().sort();
}
function iso(value: unknown): string | null {
  if (value === null) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  throw new BoundaryError(503);
}
function view(deviation: Record<string, any>, practiceIds: string[]) {
  return {
    deviationId: deviation.deviation_id,
    startAt: iso(deviation.start_at),
    endAt: iso(deviation.end_at),
    endedAt: iso(deviation.ended_at),
    deletedAt: iso(deviation.deleted_at),
    scope: deviation.scope,
    type: deviation.type,
    reason: deviation.reason,
    policy: deviation.policy,
    provenance: deviation.provenance,
    practiceIds: normalizedIds(practiceIds),
  };
}
async function associations(store: Store) {
  return store.associations.list() as Promise<Record<string, any>[]>;
}
async function validatePractices(store: Store, practiceIds: string[]) {
  // Resolve every selected practice through the authenticated owner's scoped
  // store before any break or association is written.
  for (const practiceId of normalizedIds(practiceIds)) await store.domains.get([practiceId]);
}
function idsFor(deviationId: string, rows: Record<string, any>[]) {
  return rows.filter(row => row.deviation_id === deviationId).map(row => String(row.domain_id)).sort();
}

/**
 * Authenticated, owner-scoped break lifecycle. Each service operation uses one
 * pinned ownership transaction; the store calls below nest on that same
 * transaction so row state, selected practices and audit entries are atomic.
 */
export function createDeviationServiceV2(unit: Unit, options: { clock?: () => Date } = {}) {
  if (!unit || typeof unit.run !== "function" || !options || typeof options !== "object" ||
      Object.keys(options).some(key => key !== "clock") ||
      (Object.hasOwn(options, "clock") && typeof options.clock !== "function"))
    throw new BoundaryError(503);
  const clock = options.clock ?? (() => new Date());
  return Object.freeze({
    list: (request: Request) => unit.run(request, async ownership => {
      const store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      const deviations = await store.deviations.list();
      const links = await associations(store);
      return deviations.filter((row: any) => row.deleted_at === null)
        .map((row: any) => view(row, idsFor(row.deviation_id, links)));
    }),
    read: (request: Request, key: unknown) => unit.run(request, async ownership => {
      const store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      const row: any = await store.deviations.get([key]);
      if (row.deleted_at !== null) throw new BoundaryError(404);
      return view(row, idsFor(row.deviation_id, await associations(store)));
    }),
    create: (request: Request, input: unknown) => unit.run(request, async ownership => {
      const payload = parse(createInput, input);
      const practiceIds = normalizedIds(payload.practiceIds);
      const store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      await validatePractices(store, practiceIds);
      const deviationId = randomUUID();
      const row = await store.deviations.create({
        deviationId,
        startAt: payload.startAt,
        endAt: payload.endAt,
        scope: "selected",
        type: payload.type,
        reason: payload.reason,
        // These are the existing opaque declared-intent fields. The break
        // lifecycle does not interpret them or turn them into scoring rules.
        policy: {},
        provenance: {},
      }, payload.changeReason);
      for (const practiceId of practiceIds)
        await store.associations.create([deviationId, practiceId], payload.changeReason);
      return view(row, practiceIds);
    }),
    edit: (request: Request, key: unknown, input: unknown) => unit.run(request, async ownership => {
      const payload = parse(editInput, input);
      const store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      const row = await store.deviations.editSelected([key], {
        startAt: payload.startAt,
        endAt: payload.endAt,
        reason: payload.reason,
      }, payload.practiceIds, payload.changeReason);
      return view(row.deviation, row.domainIds);
    }),
    end: (request: Request, key: unknown, input: unknown) => unit.run(request, async ownership => {
      const payload = parse(lifecycleInput, input);
      const store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      const current: any = await store.deviations.get([key]);
      if (current.deleted_at !== null) throw new BoundaryError(404);
      if (current.ended_at !== null) return view(current, idsFor(current.deviation_id, await associations(store)));
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new BoundaryError(503);
      const row = await store.deviations.end([key], now.toISOString(), payload.changeReason);
      return view(row, idsFor(current.deviation_id, await associations(store)));
    }),
    softDelete: (request: Request, key: unknown, input: unknown) => unit.run(request, async ownership => {
      const payload = parse(lifecycleInput, input);
      const store = createPolicyV2Storage(ownership.db, ownership.context, { clock });
      const current: any = await store.deviations.get([key]);
      if (current.deleted_at !== null) return view(current, idsFor(current.deviation_id, await associations(store)));
      const row = await store.deviations.delete([key], payload.changeReason);
      return view(row, idsFor(current.deviation_id, await associations(store)));
    }),
  });
}
