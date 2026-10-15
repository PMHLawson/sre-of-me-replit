import { policyStateResponseSchema, escalationStateResponseSchema } from "@shared/schema";
import type { SessionSummary, DeviationSummary, HistoryPage, SessionStateBundle, TextChunk } from "@shared/legacy-history";
import type { Session, Deviation } from "@/store";

export type DetailState<T> = { status: "loading" | "incomplete" | "ready" | "error"; value?: T;
  textVersion?: string; offsets?: Record<string, number | null>; error?: string };
const domains = new Set(["fitness", "meditation", "music", "martial-arts"]);
const instant = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function session(v: unknown): v is SessionSummary {
  return object(v) && typeof v.id === "string" && domains.has(v.domain) &&
    Number.isSafeInteger(v.durationMinutes) && v.durationMinutes > 0 && instant(v.timestamp) &&
    (v.deletedAt === null || instant(v.deletedAt)) && typeof v.isAnomaly === "boolean" &&
    v.notes === null && v.anomalyNote === null && typeof v.hasNotes === "boolean" &&
    typeof v.hasAnomalyNote === "boolean" && Number.isSafeInteger(v.notesBytes) && v.notesBytes >= 0 &&
    Number.isSafeInteger(v.anomalyNoteBytes) && v.anomalyNoteBytes >= 0 &&
    v.notesAvailability === (v.hasNotes ? 'not_loaded' : 'absent') &&
    v.anomalyNoteAvailability === (v.hasAnomalyNote ? 'not_loaded' : 'absent') &&
    typeof v.userId === 'string';
}
function deviation(v: unknown): v is DeviationSummary {
  return object(v) && typeof v.id === "string" && domains.has(v.domain) && instant(v.startAt) &&
    [v.endAt, v.endedAt, v.deletedAt].every(x => x === null || instant(x)) &&
    typeof v.excludeFromComposite === "boolean" && v.reason === "" &&
    typeof v.hasReason === "boolean" && Number.isSafeInteger(v.reasonBytes) && v.reasonBytes >= 0 &&
    v.reasonAvailability === (v.hasReason ? "not_loaded" : "absent") && typeof v.userId === "string";
}
export const asSession = (v: SessionSummary): Session => ({ ...v, textComplete: false });
export const asDeviation = (v: DeviationSummary): Deviation => ({ ...v, textComplete: false });
async function json(url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 409 ?
    "This record changed. Restart loading its text." : "Could not verify your saved records. Please retry.");
  return response.json();
}
export async function readSessionState(days: number, signal?: AbortSignal): Promise<SessionStateBundle> {
  const v = await json("/api/session-state?days=" + days, signal);
  if (!object(v) || v.complete !== true || !instant(v.asOf) || !object(v.context) ||
      v.context.complete !== true || !instant(v.context.fromInclusive) ||
      !Array.isArray(v.context.sessions) || !v.context.sessions.every(session) ||
      !Array.isArray(v.context.deviations) || !v.context.deviations.every(deviation))
    throw new Error("The current window is incomplete or invalid. No result has been inferred.");
  const policy = policyStateResponseSchema.safeParse(v.policyState);
  const escalation = escalationStateResponseSchema.safeParse(v.escalationState);
  if (!policy.success || !escalation.success || !policy.data.windowSets || !policy.data.sessionDays ||
      (policy.success && v.context.sessions.some((row: SessionSummary) => !policy.data.sessionDays?.[row.id])) ||
      policy.data.logical_day !== escalation.data.logical_day ||
      [...domains].some(d => !policy.data.services[d as keyof typeof policy.data.services] ||
        !escalation.data.perDomain[d as keyof typeof escalation.data.perDomain]))
    throw new Error("The current results could not be verified.");
  return { ...v, policyState: policy.data, escalationState: escalation.data } as SessionStateBundle;
}
export async function readHistoryPage(kind: "sessions" | "deleted" | "deviations", cursor: string | null,
  signal?: AbortSignal): Promise<HistoryPage<SessionSummary | DeviationSummary>> {
  const path = kind === "deleted" ? "/api/sessions/deleted" : "/api/" + kind;
  const v = await json(path + "?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), signal);
  const validate = kind === "deviations" ? deviation : session;
  if (!object(v) || !Array.isArray(v.items) || !v.items.every(validate) ||
      !(v.nextCursor === null || (typeof v.nextCursor === "string" && v.nextCursor.length > 0)) ||
      v.complete !== (v.nextCursor === null) || (cursor !== null && v.nextCursor === cursor)) throw new Error("History could not be verified.");
  return v as HistoryPage<SessionSummary | DeviationSummary>;
}
export function mergeById<T extends { id: string }>(prior: T[], next: T[]): T[] {
  const map = new Map(prior.map(row => [row.id, row]));
  for (const row of next) map.set(row.id, row);
  return [...map.values()];
}
/** One user action advances at most one chunk of each field; never follows cursors in a loop. */
export async function readDetailStep(kind: "sessions" | "deviations", id: string,
  previous?: DetailState<Session | Deviation>, signal?: AbortSignal): Promise<DetailState<Session | Deviation>> {
  const base = "/api/" + kind + "/" + encodeURIComponent(id);
  const first = !previous?.value || !previous.textVersion;
  const raw = first ? await json(base, signal) : previous!.value;
  const validate = kind === "sessions" ? session : deviation;
  if (first && (!validate(raw) || !/^[a-f0-9]{64}$/.test((raw as any).textVersion)))
    throw new Error("The saved record could not be verified.");
  const version = first ? raw.textVersion : previous!.textVersion!;
  const fields = kind === "sessions" ? ["notes", "anomalyNote"] : ["reason"];
  const value: any = { ...raw, textComplete: false };
  const offsets: Record<string, number | null> = { ...(previous?.offsets ?? {}) };
  for (const field of fields) {
    if (!first && offsets[field] === null) continue;
    const offset = first ? 0 : offsets[field];
    if (offset === undefined) throw new Error("Restart loading this record.");
    const c: TextChunk = await json(base + "/text?field=" + field + "&version=" + version + "&offset=" + offset, signal);
    if (!object(c) || c.textVersion !== version || c.offset !== offset ||
        !(c.text === null || typeof c.text === "string") || (typeof c.text === "string" && Array.from(c.text).length > 2048) ||
        !(c.nextOffset === null || (Number.isSafeInteger(c.nextOffset) && c.nextOffset > offset)) ||
        !Number.isSafeInteger(c.bytes) || c.bytes < 0 || (!first && c.text === null))
      throw new Error("The saved text could not be verified. Restart loading it.");
    const hasKey = field === "notes" ? "hasNotes" : field === "anomalyNote" ? "hasAnomalyNote" : "hasReason";
    if (first && ((c.text === null) !== !value[hasKey])) throw new Error("Saved text presence could not be verified.");
    const bytesKey = field === "notes" ? "notesBytes" : field === "anomalyNote" ? "anomalyNoteBytes" : "reasonBytes";
    if (c.bytes !== value[bytesKey] || (c.nextOffset !== null && c.nextOffset !== offset + Array.from(c.text ?? "").length))
      throw new Error("The saved text coverage could not be verified.");
    value[field] = first ? c.text : (value[field] ?? "") + c.text;
    if (c.nextOffset === null && new TextEncoder().encode(value[field] ?? "").byteLength !== c.bytes)
      throw new Error("The complete saved text could not be verified.");
    offsets[field] = c.nextOffset;
  }
  const complete = fields.every(field => offsets[field] === null);
  value.textComplete = complete;
  return { status: complete ? "ready" : "incomplete", value, textVersion: version, offsets };
}
