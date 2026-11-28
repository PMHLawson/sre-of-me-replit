import { z } from "zod";
import { ActivityIdSchema, ActivityTimestampSchema } from "@shared/activity";
import { isActivityOwner } from "./activities-api";

const id = ActivityIdSchema;
const reason = z.string().trim().min(1).max(500);
const editableInstant = z.string().max(64).datetime({ offset: true }).refine(value =>
  (value.match(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/)?.[1].length ?? 0) <= 6);
const writePracticeIds = z.array(id).min(1).max(100).refine(values => new Set(values).size === values.length);
const savedPracticeIds = z.array(id).max(1000).refine(values => new Set(values).size === values.length);

const deviationSchema = z.object({
  deviationId: id,
  startAt: editableInstant,
  endAt: editableInstant.nullable(),
  endedAt: editableInstant.nullable(),
  deletedAt: editableInstant.nullable(),
  scope: z.enum(["all", "selected"]),
  type: z.enum(["stitch", "substitute_target"]),
  reason: z.string().min(1),
  policy: z.unknown(),
  provenance: z.unknown(),
  practiceIds: savedPracticeIds,
}).strict().refine(value => value.scope === "all" || value.practiceIds.length > 0);
export type PersonalDeviation = z.infer<typeof deviationSchema>;

const createSchema = z.object({
  startAt: ActivityTimestampSchema,
  endAt: ActivityTimestampSchema.nullable(),
  reason,
  changeReason: reason,
  practiceIds: writePracticeIds,
  type: z.literal("stitch"),
}).strict().refine(value => value.endAt === null || compareInstants(value.endAt, value.startAt) > 0);
export type PersonalDeviationCreate = z.infer<typeof createSchema>;

const editSchema = z.object({
  startAt: editableInstant,
  endAt: editableInstant.nullable(),
  reason,
  changeReason: reason,
  practiceIds: writePracticeIds,
}).strict().refine(value => value.endAt === null || compareInstants(value.endAt, value.startAt) > 0);
export type PersonalDeviationEdit = z.infer<typeof editSchema>;

const lifecycleSchema = z.object({ changeReason: reason }).strict();
export class PersonalDeviationApiError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "Sign in again before managing breaks." :
      status === 404 ? "This break or one of its selected practices is no longer available." :
      status === 400 ? "The break could not be saved. Check the reason, dates, and selected practices." :
      "The break could not be confirmed. Refresh saved breaks before trying again.");
    this.name = "PersonalDeviationApiError";
  }
}

function owner(value: string): string {
  if (!isActivityOwner(value)) throw new PersonalDeviationApiError(401);
  return value;
}
function ticks(value: string): bigint | null {
  const milliseconds = Date.parse(value);
  const fraction = value.match(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/)?.[1] ?? "";
  if (!Number.isFinite(milliseconds) || fraction.length > 6) return null;
  return BigInt(milliseconds) * BigInt(1000) + BigInt(fraction.padEnd(6, "0").slice(3));
}
function compareInstants(left: string, right: string): number {
  const a = ticks(left), b = ticks(right);
  return a === null || b === null ? 0 : a < b ? -1 : a > b ? 1 : 0;
}
function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = left.slice().sort(), sortedRight = right.slice().sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
function parseDeviation(value: unknown): PersonalDeviation {
  const result = deviationSchema.safeParse(value);
  if (!result.success) throw new PersonalDeviationApiError(503);
  return result.data;
}
async function request(path: string, signal?: AbortSignal, method?: "POST" | "PATCH" | "DELETE", body?: unknown) {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      cache: "no-store",
      signal,
      ...(method ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if ((error as { name?: unknown })?.name === "AbortError") throw error;
    throw new PersonalDeviationApiError(503);
  }
  if (!response.ok) throw new PersonalDeviationApiError(response.status);
  try { return await response.json(); } catch { throw new PersonalDeviationApiError(503); }
}

export const PERSONAL_DEVIATIONS_QUERY = "personal-deviations";
export function personalDeviationsQuery(ownerId: string) {
  const account = owner(ownerId);
  return {
    queryKey: [PERSONAL_DEVIATIONS_QUERY, account] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<PersonalDeviation[]> => {
      const value = await request("/api/v2/deviations", signal);
      owner(account);
      if (!Array.isArray(value)) throw new PersonalDeviationApiError(503);
      const rows = value.map(parseDeviation);
      if (new Set(rows.map(row => row.deviationId)).size !== rows.length) throw new PersonalDeviationApiError(503);
      return rows;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false as const,
    refetchOnWindowFocus: false,
  };
}

function verifyMutationResponse(value: unknown, expected: {
  deviationId?: string; startAt?: string; endAt?: string | null; reason?: string; practiceIds?: string[];
  type?: "stitch"; scope?: "selected"; ended?: boolean; deleted?: boolean;
}): PersonalDeviation {
  const saved = parseDeviation(value);
  if ((expected.deviationId !== undefined && saved.deviationId !== expected.deviationId) ||
    (expected.startAt !== undefined && compareInstants(saved.startAt, expected.startAt) !== 0) ||
    (expected.endAt !== undefined && (expected.endAt === null ? saved.endAt !== null :
      saved.endAt === null || compareInstants(saved.endAt, expected.endAt) !== 0)) ||
    (expected.reason !== undefined && saved.reason !== expected.reason) ||
    (expected.type !== undefined && saved.type !== expected.type) ||
    (expected.scope !== undefined && saved.scope !== expected.scope) ||
    (expected.ended !== undefined && (saved.endedAt !== null) !== expected.ended) ||
    (expected.deleted !== undefined && (saved.deletedAt !== null) !== expected.deleted) ||
    (expected.practiceIds !== undefined && !sameIds(saved.practiceIds, expected.practiceIds)))
    throw new PersonalDeviationApiError(503);
  return saved;
}

export async function createPersonalDeviation(ownerId: string, input: PersonalDeviationCreate): Promise<PersonalDeviation> {
  const account = owner(ownerId), payload = createSchema.parse(input);
  const value = await request("/api/v2/deviations", undefined, "POST", payload);
  owner(account);
  return verifyMutationResponse(value, { ...payload, scope: "selected" });
}
export async function editPersonalDeviation(ownerId: string, deviation: PersonalDeviation, input: PersonalDeviationEdit): Promise<PersonalDeviation> {
  const account = owner(ownerId);
  if (deviation.scope !== "selected") throw new PersonalDeviationApiError(400);
  const key = id.parse(deviation.deviationId), payload = editSchema.parse(input);
  const value = await request(`/api/v2/deviations/${encodeURIComponent(key)}`, undefined, "PATCH", payload);
  owner(account);
  return verifyMutationResponse(value, { deviationId: key, ...payload, scope: "selected" });
}
export async function endPersonalDeviation(ownerId: string, deviation: PersonalDeviation, changeReason: string): Promise<PersonalDeviation> {
  const account = owner(ownerId), key = id.parse(deviation.deviationId), payload = lifecycleSchema.parse({ changeReason });
  const value = await request(`/api/v2/deviations/${encodeURIComponent(key)}/end`, undefined, "POST", payload);
  owner(account);
  return verifyMutationResponse(value, { deviationId: key, practiceIds: deviation.practiceIds, ended: true });
}
export async function deletePersonalDeviation(ownerId: string, deviation: PersonalDeviation, changeReason: string): Promise<PersonalDeviation> {
  const account = owner(ownerId), key = id.parse(deviation.deviationId), payload = lifecycleSchema.parse({ changeReason });
  const value = await request(`/api/v2/deviations/${encodeURIComponent(key)}`, undefined, "DELETE", payload);
  owner(account);
  return verifyMutationResponse(value, { deviationId: key, practiceIds: deviation.practiceIds, deleted: true });
}
