import { performance } from "node:perf_hooks";
import { BoundaryError, type Transaction } from "./org-context";

export const OWNER_WRITE_LIMITS = Object.freeze({ minute: 30, day: 500, capacityBytes: 100 * 1024 * 1024 });
export interface OwnerWriteBudgetOptions { capacityBytes?: number; enforceCapacity?: boolean }
export interface OwnerWriteAdmission { admitMutation: () => Promise<void> }
export interface OwnerWriteBudgetStatus {
  ownerUserId: string; asOf: string;
  minute: { used: number; limit: number; remaining: number; resetsAt: string };
  day: { used: number; limit: number; remaining: number; resetsAt: string };
  storage: { usedBytes: number; limitBytes: number; enforcement: "monitor_only" | "growth_only"; overLimit: boolean };
}
export class WriteResourceLimitError extends BoundaryError {
  readonly code: "WRITE_RATE_LIMIT_EXCEEDED" | "OWNER_CAPACITY_EXCEEDED";
  constructor(kind: "rate" | "capacity", public readonly retryAfterSeconds: number | null = null) {
    super(429);
    this.name = "WriteResourceLimitError";
    this.code = kind === "rate" ? "WRITE_RATE_LIMIT_EXCEEDED" : "OWNER_CAPACITY_EXCEEDED";
    this.message = kind === "rate" ? "Your write allowance has been reached. Please retry later." :
      "This change would increase stored data beyond your capacity allowance. Your saved records have not been changed.";
  }
}
type Options = { capacityBytes: number; enforceCapacity: boolean };
type State = {
  tx: Transaction; owner: string; options: Options; deadline: number; depth: number;
  initialized: Promise<void>; admitted?: Promise<void>; beforeBytes?: number;
  failure?: BoundaryError; poisoned?: Promise<void>;
};
// Execution state only. Accepted counts live in PostgreSQL, never in this map.
const scopes = new WeakMap<Transaction, State>();
const validOwner = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && value !== "__proto__";
function optionsFor(input: OwnerWriteBudgetOptions = {}): Options {
  if (!input || typeof input !== "object" || Object.keys(input).some(k => !["capacityBytes","enforceCapacity"].includes(k)) ||
    (input.enforceCapacity !== undefined && typeof input.enforceCapacity !== "boolean")) throw new BoundaryError(503);
  const capacityBytes = input.capacityBytes ?? OWNER_WRITE_LIMITS.capacityBytes;
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1) throw new BoundaryError(503);
  return { capacityBytes, enforceCapacity: input.enforceCapacity ?? false };
}
const normalizedError = (error: unknown) => error instanceof BoundaryError ? error : new BoundaryError(503);
async function poison(state: State, error: unknown): Promise<never> {
  state.failure ??= normalizedError(error);
  if (!state.poisoned) {
    // A caught JavaScript rejection must not let a caller commit earlier writes.
    // This static, parameter-free SQL error puts the SAME transaction in abort.
    state.poisoned = state.tx.query("SELECT CAST('owner write budget rejected' AS integer)")
      .then(() => undefined, () => undefined);
  }
  await state.poisoned;
  throw state.failure;
}
async function query(state: State, text: string, values: unknown[] = []) {
  if (state.failure) throw state.failure;
  const left = Math.floor(state.deadline - performance.now());
  if (left < 1) throw new BoundaryError(503);
  const timeout = Math.max(1, Math.min(2500, left));
  await state.tx.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
    [String(timeout), String(Math.min(1000, timeout))]);
  if (performance.now() >= state.deadline) throw new BoundaryError(503);
  return state.tx.query(text, values);
}
function whole(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new BoundaryError(503);
  return result;
}
function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new BoundaryError(503);
  return new Date(value).toISOString();
}
// Logical serialized JSON UTF-8 bytes, including every saved version, soft-deleted
// row, canonical copy and owned audit snapshot. No payload rows leave PostgreSQL.
// Operational HTTP sessions, shared organization rows and counter metadata are
// excluded because they are not owner-authored practice/configuration history.
const ownedTables = ["domains","policy_versions","dimension_definitions","observations","evaluation_results",
  "deviations_v2","deviation_domains","source_bindings"] as const;
const footprint = [
  ...["sessions","session_edits","deviations","user_settings"].map(table =>
    "(SELECT COALESCE(sum(octet_length(to_jsonb(t)::text)::bigint),0) FROM public." + table + " t WHERE t.user_id=$1)"),
  ...ownedTables.map(table =>
    "(SELECT COALESCE(sum(octet_length(to_jsonb(t)::text)::bigint),0) FROM public." + table + " t WHERE t.owner_user_id=$1)"),
  "(SELECT COALESCE(sum(octet_length(to_jsonb(t)::text)::bigint),0) FROM public.audit_events t WHERE t.actor_kind='user' AND t.actor_user_id=$1)",
  "(SELECT COALESCE(sum(octet_length(to_jsonb(t)::text)::bigint),0) FROM public.users t WHERE t.id=$1)",
].join("+");
async function measure(state: State): Promise<number> {
  const result = await query(state, "SELECT (" + footprint + ")::text AS used_bytes", [state.owner]);
  if (result.rows.length !== 1) throw new BoundaryError(503);
  return whole(result.rows[0].used_bytes);
}
async function admit(state: State): Promise<void> {
  await query(state, "INSERT INTO public.owner_write_resource_budgets(owner_user_id) VALUES($1) ON CONFLICT(owner_user_id) DO NOTHING", [state.owner]);
  const saved = (await query(state,
    "SELECT minute_started_at::text,minute_count,day_date::text,day_count FROM public.owner_write_resource_budgets WHERE owner_user_id=$1 FOR UPDATE",
    [state.owner])).rows;
  if (saved.length !== 1) throw new BoundaryError(503);
  // Capture server time AFTER the owner/counter locks, never before waiting.
  const clocks = (await query(state, "SELECT now::text AS now,date_trunc('minute',now)::text AS minute_started_at,(now AT TIME ZONE 'UTC')::date::text AS day_date FROM (SELECT clock_timestamp() AS now) clock")).rows;
  if (clocks.length !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(clocks[0].day_date)) throw new BoundaryError(503);
  const row = saved[0], clock = clocks[0], now = iso(clock.now);
  const minuteStart = Date.parse(iso(row.minute_started_at)) >= Date.parse(iso(clock.minute_started_at)) ?
    iso(row.minute_started_at) : iso(clock.minute_started_at);
  const dayDate = String(row.day_date) >= clock.day_date ? String(row.day_date) : clock.day_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDate)) throw new BoundaryError(503);
  const minuteCount = minuteStart === iso(row.minute_started_at) ? whole(row.minute_count) : 0;
  const dayCount = dayDate === String(row.day_date) ? whole(row.day_count) : 0;
  if (minuteCount >= OWNER_WRITE_LIMITS.minute || dayCount >= OWNER_WRITE_LIMITS.day) {
    const reset = dayCount >= OWNER_WRITE_LIMITS.day ? Date.parse(dayDate + "T00:00:00Z") + 86400000 :
      Date.parse(minuteStart) + 60000;
    throw new WriteResourceLimitError("rate", Math.max(1, Math.ceil((reset - Date.parse(now)) / 1000)));
  }
  state.beforeBytes = await measure(state);
  await query(state, "UPDATE public.owner_write_resource_budgets SET minute_started_at=$2::timestamptz,minute_count=$3,day_date=$4::date,day_count=$5,updated_at=$6::timestamptz WHERE owner_user_id=$1",
    [state.owner, minuteStart, minuteCount + 1, dayDate, dayCount + 1, now]);
}
/** Authenticated server seam. Call inside the SAME business/audit transaction.
 * Await admitMutation immediately before the first actual mutation, after
 * validation/replay/no-op decisions. Nested and sequential scopes sharing the
 * same transaction/owner reuse one charge. The outermost scope checks growth.
 */
export async function withOwnerWriteBudget<T>(tx: Transaction, ownerUserId: string,
  operation: (budget: OwnerWriteAdmission) => Promise<T>, input?: OwnerWriteBudgetOptions): Promise<T> {
  if (!validOwner(ownerUserId) || !tx || typeof tx.query !== "function" || typeof operation !== "function") throw new BoundaryError(403);
  const options = optionsFor(input);
  let state = scopes.get(tx);
  if (state) {
    if (state.owner !== ownerUserId || state.options.capacityBytes !== options.capacityBytes ||
      state.options.enforceCapacity !== options.enforceCapacity) return poison(state, new BoundaryError(403));
  } else {
    state = { tx, owner: ownerUserId, options, deadline: performance.now() + 15000, depth: 0, initialized: Promise.resolve() };
    scopes.set(tx, state);
    // Common first lock: users -> business validation rows -> owner counter.
    const current = state;
    current.initialized = (async () => {
      const user = await query(current, "SELECT id FROM public.users WHERE id=$1 FOR UPDATE", [ownerUserId]);
      if (user.rows.length !== 1) throw new BoundaryError(403);
    })();
    void current.initialized.catch(() => {});
  }
  const current = state;
  try {
    if (current.failure) throw current.failure;
    await current.initialized;
    current.depth++;
    let value: T;
    try {
      value = await operation(Object.freeze({ admitMutation: () => {
        if (!current.admitted) {
          current.admitted = admit(current).catch(error => poison(current, error));
          // Observe the EXACT returned promise even if an internal caller errs.
          void current.admitted.catch(() => {});
        }
        return current.admitted;
      }}));
    } finally { current.depth--; }
    if (current.admitted) await current.admitted;
    if (current.failure) throw current.failure;
    if (current.depth === 0 && current.admitted) {
      const after = await measure(current), before = current.beforeBytes;
      if (before === undefined) throw new BoundaryError(503);
      if (options.enforceCapacity && after > options.capacityBytes && after > before)
        throw new WriteResourceLimitError("capacity");
      await query(current, "UPDATE public.owner_write_resource_budgets SET observed_bytes=$2,observed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE owner_user_id=$1", [ownerUserId, after]);
    }
    if (performance.now() >= current.deadline) throw new BoundaryError(503);
    return value;
  } catch (error) { return poison(current, error); }
}
/** Read-only, one-statement owner usage snapshot; no counter creation/charge. */
export async function readOwnerWriteBudgetStatus(tx: Transaction, ownerUserId: string,
  input?: OwnerWriteBudgetOptions): Promise<OwnerWriteBudgetStatus> {
  if (!validOwner(ownerUserId)) throw new BoundaryError(403);
  const options = optionsFor(input), state: State = { tx, owner: ownerUserId, options,
    deadline: performance.now() + 15000, depth: 0, initialized: Promise.resolve() };
  const result = await query(state, "SELECT clock.now::text AS now,b.minute_started_at::text,b.minute_count,b.day_date::text,b.day_count,(" + footprint +
    ")::text AS used_bytes FROM public.users u CROSS JOIN (SELECT clock_timestamp() AS now) clock LEFT JOIN public.owner_write_resource_budgets b ON b.owner_user_id=u.id WHERE u.id=$1", [ownerUserId]);
  if (result.rows.length !== 1) throw new BoundaryError(403);
  const row = result.rows[0], now = iso(row.now), nowMs = Date.parse(now);
  const minuteStart = row.minute_started_at === null ? Math.floor(nowMs / 60000) * 60000 : Math.max(Date.parse(iso(row.minute_started_at)), Math.floor(nowMs / 60000) * 60000);
  const today = now.slice(0,10), dayDate = row.day_date === null ? today : String(row.day_date) > today ? String(row.day_date) : today;
  const minuteUsed = row.minute_started_at !== null && Date.parse(iso(row.minute_started_at)) === minuteStart ? whole(row.minute_count) : 0;
  const dayUsed = row.day_date !== null && String(row.day_date) === dayDate ? whole(row.day_count) : 0;
  const usedBytes = whole(row.used_bytes);
  return { ownerUserId, asOf: now,
    minute: { used: minuteUsed, limit: OWNER_WRITE_LIMITS.minute, remaining: Math.max(0, OWNER_WRITE_LIMITS.minute - minuteUsed), resetsAt: new Date(minuteStart + 60000).toISOString() },
    day: { used: dayUsed, limit: OWNER_WRITE_LIMITS.day, remaining: Math.max(0, OWNER_WRITE_LIMITS.day - dayUsed), resetsAt: new Date(Date.parse(dayDate + "T00:00:00Z") + 86400000).toISOString() },
    storage: { usedBytes, limitBytes: options.capacityBytes, enforcement: options.enforceCapacity ? "growth_only" : "monitor_only", overLimit: usedBytes > options.capacityBytes } };
}
