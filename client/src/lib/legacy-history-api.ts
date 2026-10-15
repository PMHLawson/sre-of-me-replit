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
const calendarMs = 24 * 60 * 60 * 1000;
function dayKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function keysEndingAt(today: string, count: number, includeToday = false): string[] {
  const anchor = Date.parse(today + "T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) =>
    new Date(anchor - (count - index - (includeToday ? 1 : 0)) * calendarMs).toISOString().slice(0, 10));
}
const sameKeys = (a: readonly string[] | undefined, b: readonly string[]) =>
  !!a && a.length === b.length && a.every((key, index) => key === b[index]);
/** Verifies completeness/identity metadata, never recomputes scoring or timezone policy. */
export function validWindowCoverage(bundle: SessionStateBundle, days: number): boolean {
  const p = bundle.policyState, e = bundle.escalationState, w = p.windowSets, today = p.logical_day;
  if (!Number.isSafeInteger(days) || days < 1 || days > 60 || !w || !dayKey(today) ||
      w.todayKey !== today || e.logical_day !== today ||
      !sameKeys(w.w7, keysEndingAt(today, 7)) || !sameKeys(w.w14, keysEndingAt(today, 14)) ||
      !sameKeys(w.w28, keysEndingAt(today, 28)) || !sameKeys(w.w42, keysEndingAt(today, 42)) ||
      !sameKeys(w.prev7, keysEndingAt(today, 14).slice(0, 7)) ||
      p.window_days.length < 1 || p.window_days.length > 90 ||
      !sameKeys(p.window_days, keysEndingAt(today, p.window_days.length)) ||
      e.history.length !== days || e.history.some((row, index) => !dayKey(row.logical_day) ||
        (index > 0 && e.history[index - 1].logical_day >= row.logical_day)) ||
      !p.sessionDays || Object.values(p.sessionDays).some(value => !dayKey(value))) return false;
  const from = Date.parse(bundle.context.fromInclusive), asOf = Date.parse(bundle.asOf);
  if (!Number.isFinite(from) || !Number.isFinite(asOf) || from > asOf - 90 * calendarMs ||
      Math.abs(asOf - Date.parse(today + "T00:00:00.000Z")) > 2 * calendarMs) return false;
  for (const domain of Array.from(domains)) {
    const service = p.services[domain as keyof typeof p.services];
    if (!service || service.domain !== domain || service.logical_day !== today ||
        !sameKeys(service.window_days, p.window_days) ||
        e.history.some(row => !row.perDomain[domain as keyof typeof row.perDomain])) return false;
  }
  return bundle.context.sessions.every(row => {
    const key = p.sessionDays![row.id];
    return dayKey(key) && Date.parse(row.timestamp) >= from &&
      Math.abs(Date.parse(row.timestamp) - Date.parse(key + "T00:00:00.000Z")) <= 2 * calendarMs;
  });
}

export const asSession = (v: SessionSummary): Session => ({ ...v, textComplete: false });
export const asDeviation = (v: DeviationSummary): Deviation => ({ ...v, textComplete: false });
async function json(url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 409 ?
    "This record changed. Restart loading its text." : "Could not verify your saved records. Please retry.");
  return response.json();
}
export async function readSessionState(days: number, signal: AbortSignal | undefined, owner: string): Promise<SessionStateBundle> {
  const v = await json("/api/session-state?days=" + days, signal);
  if (!owner || !object(v) || v.ownerUserId !== owner || v.complete !== true || !instant(v.asOf) || !object(v.context) ||
      v.context.complete !== true || !instant(v.context.fromInclusive) ||
      !Array.isArray(v.context.sessions) || v.context.sessions.length > 2000 || !v.context.sessions.every((row: unknown) => session(row) && row.userId === owner) ||
      !Array.isArray(v.context.deviations) || v.context.deviations.length > 1000 || !v.context.deviations.every((row: unknown) => deviation(row) && row.userId === owner))
    throw new Error("The current window is incomplete or invalid. No result has been inferred.");
  const policy = policyStateResponseSchema.safeParse(v.policyState);
  const escalation = escalationStateResponseSchema.safeParse(v.escalationState);
  if (!policy.success || !escalation.success || !policy.data.windowSets || !policy.data.sessionDays ||
      (policy.success && v.context.sessions.some((row: SessionSummary) => !policy.data.sessionDays?.[row.id])) ||
      policy.data.logical_day !== escalation.data.logical_day ||
      Array.from(domains).some(d => !policy.data.services[d as keyof typeof policy.data.services] ||
        !escalation.data.perDomain[d as keyof typeof escalation.data.perDomain]))
    throw new Error("The current results could not be verified.");
  const bundle = { ...v, policyState: policy.data, escalationState: escalation.data } as SessionStateBundle;
  if (!validWindowCoverage(bundle, days)) throw new Error("The current window coverage could not be verified.");
  return bundle;
}
export async function readHistoryPage(kind: "sessions" | "deleted" | "deviations", cursor: string | null,
  signal: AbortSignal | undefined, owner: string): Promise<HistoryPage<SessionSummary | DeviationSummary>> {
  const path = kind === "deleted" ? "/api/sessions/deleted" : "/api/" + kind;
  const v = await json(path + "?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), signal);
  const validate = kind === "deviations" ? deviation : session;
  if (!owner || !object(v) || !Array.isArray(v.items) || v.items.length > 50 || !v.items.every((row: unknown) => validate(row) && row.userId === owner) ||
      !(v.nextCursor === null || (typeof v.nextCursor === "string" && v.nextCursor.length > 0)) ||
      v.complete !== (v.nextCursor === null) || (v.items.length === 0 && v.nextCursor !== null) || (cursor !== null && v.nextCursor === cursor)) throw new Error("History could not be verified.");
  return v as HistoryPage<SessionSummary | DeviationSummary>;
}
export function mergeById<T extends { id: string }>(prior: T[], next: T[]): T[] {
  const map = new Map(prior.map(row => [row.id, row]));
  for (const row of next) map.set(row.id, row);
  return Array.from(map.values());
}
/** One user action advances at most one chunk of each field; never follows cursors in a loop. */
export async function readDetailStep(kind: "sessions" | "deviations", id: string,
  previous: DetailState<Session | Deviation> | undefined, signal: AbortSignal | undefined, owner: string): Promise<DetailState<Session | Deviation>> {
  const base = "/api/" + kind + "/" + encodeURIComponent(id);
  const first = !previous?.value || !previous.textVersion;
  const raw = first ? await json(base, signal) : previous!.value;
  const validate = kind === "sessions" ? session : deviation;
  if (!owner || raw?.id !== id || raw?.userId !== owner ||
      (first && (!validate(raw) || !/^[a-f0-9]{64}$/.test((raw as any).textVersion))))
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
