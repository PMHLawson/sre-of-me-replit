import { ActivityCreateInputSchema, ActivityCreateResultSchema, ActivitySubmissionResultSchema, ActivityEditInputSchema, ActivityLifecycleInputSchema,
  ActivityMutationResultSchema, ActivityMutationOperationSchema, ActivityEligibilitySchema, ActivityIdSchema, ActivityListInputSchema,
  ActivityListResultSchema, ActivityTimestampSchema, ActivityViewSchema, validatePracticeValues,
  type ActivityCreateInput, type ActivityEditInput, type ActivityLifecycleInput, type ActivityMutationResult, type ActivityListInput, type ActivityView } from "@shared/activity";
import { validateObservationContext, type DomainConfiguration } from "@shared/domain-config";
import type { PersonalDomain } from "./domains-api";

export const PERSONAL_ACTIVITIES_QUERY = "personal-activities";
export class ActivitiesApiError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "Sign in to view your activities." : status === 403 ? "Activity access is not available for this domain." :
      status === 404 ? "No saved activity was found for this request." : "Your activity could not be verified. Please try the saved read again.");
    this.name = "ActivitiesApiError";
  }
}
function identity(value: string): string {
  const parsed = ActivityIdSchema.safeParse(value); if (!parsed.success) throw new ActivitiesApiError(401); return parsed.data;
}
export function parseOwnedActivity(value: unknown, ownerId: string, expected?: { activityId?: string; domainId?: string }): ActivityView {
  const owner = identity(ownerId), parsed = ActivityViewSchema.safeParse(value);
  if (!parsed.success) throw new ActivitiesApiError(503);
  const activity = parsed.data, c = activity.configuration;
  if (activity.ownerUserId !== owner || c.ownerUserId !== owner || c.domainId !== activity.domainId ||
    c.policyVersionId !== activity.policyVersionId || (expected?.activityId !== undefined && expected.activityId !== activity.activityId) ||
    (expected?.domainId !== undefined && expected.domainId !== activity.domainId) ||
    !validateObservationContext(c, { schemaVersion: 1, observationId: activity.activityId, organizationId: c.organizationId,
      ownerUserId: owner, domainId: activity.domainId, policyVersionId: activity.policyVersionId, observedAt: activity.observedAt,
      values: activity.values, ...(activity.notes === undefined ? {} : { notes: activity.notes }),
      ...(activity.context === undefined ? {} : { context: activity.context }) }).success ||
    !validatePracticeValues(c, { submissionKey: "response-validation", domainId: activity.domainId,
      policyVersionId: activity.policyVersionId, practiceEvent: true, observedAt: activity.observedAt, values: activity.values,
      ...(activity.notes === undefined ? {} : { notes: activity.notes }), ...(activity.context === undefined ? {} : { context: activity.context }) }))
    throw new ActivitiesApiError(503);
  return activity;
}
export function parseOwnedActivityList(value: unknown, ownerId: string, domainId?: string) {
  const parsed = ActivityListResultSchema.safeParse(value); if (!parsed.success) throw new ActivitiesApiError(503);
  const activities = parsed.data.activities.map(activity => parseOwnedActivity(activity, ownerId, { domainId }));
  if (new Set(activities.map(activity => activity.activityId)).size !== activities.length) throw new ActivitiesApiError(503);
  return { activities, nextCursor: parsed.data.nextCursor };
}
async function request(path: string, signal?: AbortSignal, input?: unknown, method: "POST" | "PATCH" = "POST"): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { credentials: "include", signal,
    ...(input === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }) }); }
  catch (error) { if ((error as { name?: unknown })?.name === "AbortError") throw error; throw new ActivitiesApiError(503); }
  if (!response.ok) throw new ActivitiesApiError(response.status);
  try { return await response.json(); } catch { throw new ActivitiesApiError(503); }
}
export async function createPersonalActivity(ownerId: string, input: ActivityCreateInput, signal?: AbortSignal): Promise<ActivityView> {
  identity(ownerId); const submitted = ActivityCreateInputSchema.parse(input);
  const parsed = ActivityCreateResultSchema.safeParse(await request("/api/v2/activities", signal, submitted));
  if (!parsed.success || parsed.data.submissionKey !== submitted.submissionKey) throw new ActivitiesApiError(503);
  const activity = parseOwnedActivity(parsed.data.activity, ownerId, { domainId: submitted.domainId });
  if (parsed.data.created && !matchesNewActivity(activity, submitted)) throw new ActivitiesApiError(503);
  return activity;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function matchesNewActivity(activity: ActivityView, input: ActivityCreateInput): boolean {
  return activity.policyVersionId === input.policyVersionId && activity.observedAt === input.observedAt &&
    canonical(activity.values) === canonical(input.values) && canonical(activity.notes) === canonical(input.notes) &&
    canonical(activity.context) === canonical(input.context);
}
export async function readPersonalSubmission(ownerId: string, key: string, signal?: AbortSignal): Promise<ActivityView> {
  identity(ownerId); const submission = identity(key);
  const parsed = ActivitySubmissionResultSchema.safeParse(await request(`/api/v2/activities/submissions/${encodeURIComponent(submission)}`, signal));
  if (!parsed.success || parsed.data.submissionKey !== submission) throw new ActivitiesApiError(503);
  return parseOwnedActivity(parsed.data.activity, ownerId);
}
export type ActivityMutationDraft = { operation: "edit"; input: ActivityEditInput } |
  { operation: "delete" | "restore"; input: ActivityLifecycleInput };
function parsedMutation(draft: ActivityMutationDraft): ActivityMutationDraft {
  ActivityMutationOperationSchema.parse(draft.operation);
  return draft.operation === "edit" ? { operation: "edit", input: ActivityEditInputSchema.parse(draft.input) } :
    { operation: draft.operation, input: ActivityLifecycleInputSchema.parse(draft.input) };
}
function parseOwnedMutation(value: unknown, ownerId: string, base: ActivityView, key: string, operation: ActivityMutationDraft["operation"]): ActivityMutationResult {
  const parsed = ActivityMutationResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.mutationKey !== key || parsed.data.operation !== operation) throw new ActivitiesApiError(503);
  const activity = parseOwnedActivity(parsed.data.activity, ownerId, { activityId: base.activityId, domainId: base.domainId });
  if (parsed.data.changed && parsed.data.appliedStateFingerprint !== activity.stateFingerprint) throw new ActivitiesApiError(503);
  return { ...parsed.data, activity };
}
export async function mutatePersonalActivity(ownerId: string, base: ActivityView, draft: ActivityMutationDraft, signal?: AbortSignal): Promise<ActivityMutationResult> {
  const original = parseOwnedActivity(base, ownerId), parsed = parsedMutation(draft);
  const result = parseOwnedMutation(await request(`/api/v2/activities/${encodeURIComponent(original.activityId)}${parsed.operation === "edit" ? "" : `/${parsed.operation}`}`,
    signal, parsed.input, parsed.operation === "edit" ? "PATCH" : "POST"), ownerId, original, parsed.input.mutationKey, parsed.operation);
  if (result.changed && ((parsed.operation === "edit" && (!matchesNewActivity(result.activity, { ...parsed.input,
    submissionKey: "edit-acknowledgement", domainId: original.domainId }) || result.activity.deletedAt !== null)) ||
    (parsed.operation === "delete" && result.activity.deletedAt === null) || (parsed.operation === "restore" && result.activity.deletedAt !== null) ||
    (parsed.operation !== "edit" && (!matchesNewActivity(result.activity, { ...original, submissionKey: "lifecycle-acknowledgement" }) ||
      canonical(result.activity.configuration) !== canonical(original.configuration)))))
    throw new ActivitiesApiError(503);
  return result;
}
export async function readPersonalMutation(ownerId: string, base: ActivityView, key: string, operation: ActivityMutationDraft["operation"], signal?: AbortSignal): Promise<ActivityMutationResult> {
  const original = parseOwnedActivity(base, ownerId), mutationKey = identity(key);
  return parseOwnedMutation(await request(`/api/v2/activities/${encodeURIComponent(original.activityId)}/mutations/${encodeURIComponent(mutationKey)}`, signal),
    ownerId, original, mutationKey, operation);
}
export function activityEditInput(base: ActivityView, configuration: DomainConfiguration, mutationKey: string, reason: string, observedAt: string,
  fields: Record<string, ActivityField>, notes: string, contextDescription: string): ActivityEditInput {
  if (base.domainId !== configuration.domainId || base.ownerUserId !== configuration.ownerUserId) throw new ActivitiesApiError(400);
  const raw = activityInput(configuration, "edit-draft", observedAt, fields, notes, contextDescription);
  const { submissionKey: _key, domainId: _domain, ...editable } = raw;
  const conditions = base.context?.taskConditions;
  return ActivityEditInputSchema.parse({ ...editable, ...(conditions ? { context: { ...raw.context, taskConditions: structuredClone(conditions) } } : {}),
    mutationKey, expectedStateFingerprint: base.stateFingerprint, reason });
}
export function personalActivitiesQuery(ownerId: string, input: Partial<ActivityListInput> = {}) {
  const owner = identity(ownerId), list = ActivityListInputSchema.parse(input);
  const params = new URLSearchParams({ limit: String(list.limit) });
  if (list.domainId !== undefined) params.set("domainId", list.domainId);
  if (list.cursor !== undefined) params.set("cursor", list.cursor);
  return { queryKey: [PERSONAL_ACTIVITIES_QUERY, owner, "list", list.domainId ?? null, list.cursor ?? null, list.limit] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => parseOwnedActivityList(await request(`/api/v2/activities?${params}`, signal), owner, list.domainId),
    retry: false as const, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false };
}
export function personalActivityQuery(ownerId: string, activityId: string) {
  const owner = identity(ownerId), activity = identity(activityId);
  return { queryKey: [PERSONAL_ACTIVITIES_QUERY, owner, "activity", activity] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => parseOwnedActivity(await request(`/api/v2/activities/${encodeURIComponent(activity)}`, signal), owner, { activityId: activity }),
    retry: false as const, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false };
}
export function personalActivityEligibilityQuery(ownerId: string, domainId: string) {
  const owner = identity(ownerId), domain = identity(domainId);
  return { queryKey: [PERSONAL_ACTIVITIES_QUERY, owner, "eligibility", domain] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const parsed = ActivityEligibilitySchema.safeParse(await request(`/api/v2/activities/eligibility/${encodeURIComponent(domain)}`, signal));
      if (!parsed.success || parsed.data.domainId !== domain) throw new ActivitiesApiError(503);
      return parsed.data;
    }, retry: false as const, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false };
}

/** Owned domain response selects a display candidate; only the server authorizes creation. */
export function activityConfiguration(domain: PersonalDomain, observedAt: string, effectivePolicyVersionId: string): DomainConfiguration | null {
  const instant = ActivityTimestampSchema.safeParse(observedAt); if (!instant.success) return null;
  const versions = [...domain.policyVersions].map(version => version.configuration).sort((a, b) => a.revision - b.revision);
  const current = versions.find(version => version.policyVersionId === effectivePolicyVersionId);
  if (!current) return null;
  return versions.find((version, index) => version.revision <= current.revision &&
    Date.parse(version.effectiveFrom) <= Date.parse(instant.data) &&
    (!versions[index + 1] || Date.parse(instant.data) < Date.parse(versions[index + 1].effectiveFrom))) ?? null;
}
export type ActivityField = { unitId: string; valueType: "number" | "integer" | "boolean"; taskVariantId?: string; raw: string };
export function activityInput(configuration: DomainConfiguration, submissionKey: string, observedAt: string,
  fields: Record<string, ActivityField>, notes: string, contextDescription = ""): ActivityCreateInput {
  const values: ActivityCreateInput["values"] = {};
  for (const [id, field] of Object.entries(fields)) {
    if (field.raw === "") continue; // omitted never becomes zero or false
    const m = configuration.measurements.find(measurement => measurement.measurementId === id);
    if (!m || m.valueType !== field.valueType || m.unit.unitId !== field.unitId || m.taskVariantId !== field.taskVariantId)
      throw new ActivitiesApiError(400);
    const base = { unitId: field.unitId, ...(field.taskVariantId === undefined ? {} : { taskVariantId: field.taskVariantId }) };
    if (field.valueType === "boolean") {
      if (field.raw !== "true" && field.raw !== "false") throw new ActivitiesApiError(400);
      values[id] = { ...base, valueType: "boolean", value: field.raw === "true" };
    } else {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(field.raw)) throw new ActivitiesApiError(400);
      values[id] = field.valueType === "integer" ? { ...base, valueType: "integer", value: Number(field.raw) } :
        { ...base, valueType: "number", value: Number(field.raw) };
    }
  }
  const result = ActivityCreateInputSchema.safeParse({ submissionKey, domainId: configuration.domainId,
    policyVersionId: configuration.policyVersionId, practiceEvent: true, observedAt, values, ...(notes === "" ? {} : { notes }),
    ...(contextDescription.trim() === "" ? {} : { context: { description: contextDescription.trim() } }) });
  if (!result.success || !validatePracticeValues(configuration, result.data)) throw new ActivitiesApiError(400);
  return result.data;
}
export type ActivitySubmissionSnapshot = { ownerId: string; phase: "editing" | "saving" | "uncertain" | "checking" | "retry_ready" | "saved";
  draft?: ActivityCreateInput; activity?: ActivityView };
type Transport = { create: typeof createPersonalActivity; read: typeof readPersonalSubmission };
/** Imperative barrier owns key/draft before the first await; POST retries are deliberate only. */
export function createActivitySubmissionSession(ownerId: string, transport: Transport = { create: createPersonalActivity, read: readPersonalSubmission },
  options: { retainWithoutSubscribers?: boolean } = {}) {
  const owner = identity(ownerId); let state: ActivitySubmissionSnapshot = { ownerId: owner, phase: "editing" };
  const listeners = new Set<(state: ActivitySubmissionSnapshot) => void>();
  let alive = true, busy = false, generation = 0, disposal = 0, controller: AbortController | null = null;
  const emit = () => listeners.forEach(listener => listener(structuredClone(state)));
  const replace = (value: ActivitySubmissionSnapshot) => { state = value; emit(); };
  const operation = async (kind: "create" | "read") => {
    if (!alive || busy || !state.draft) return;
    busy = true; controller = new AbortController(); const token = ++generation, signal = controller.signal;
    const draft = structuredClone(state.draft);
    replace({ ownerId: owner, phase: kind === "create" ? "saving" : "checking", draft });
    try {
      const activity = kind === "create" ? await transport.create(owner, draft, signal) : await transport.read(owner, draft.submissionKey, signal);
      if (!alive || token !== generation || signal.aborted) return;
      const owned = parseOwnedActivity(activity, owner, { domainId: draft.domainId });
      replace({ ownerId: owner, phase: "saved", draft, activity: owned });
    } catch (error) {
      if (!alive || token !== generation || signal.aborted) return;
      replace({ ownerId: owner, phase: kind === "read" && error instanceof ActivitiesApiError && error.status === 404 ? "retry_ready" : "uncertain", draft });
    } finally { if (token === generation) { busy = false; controller = null; } }
  };
  return Object.freeze({
    getSnapshot: () => structuredClone(state),
    subscribe: (listener: (snapshot: ActivitySubmissionSnapshot) => void) => {
      if (!alive) return () => {}; ++disposal; listeners.add(listener); listener(structuredClone(state));
      return () => { listeners.delete(listener); const token = ++disposal;
        void Promise.resolve().then(() => { if (token === disposal && !listeners.size && !options.retainWithoutSubscribers) {
          alive = false; ++generation; controller?.abort(); state = { ownerId: owner, phase: "editing" }; } }); };
    },
    submit: (input: ActivityCreateInput) => {
      if (!alive || busy || state.phase !== "editing") return Promise.resolve();
      const draft = ActivityCreateInputSchema.parse(input); state = { ownerId: owner, phase: "editing", draft: structuredClone(draft) };
      return operation("create");
    },
    reconcile: () => state.phase === "uncertain" ? operation("read") : Promise.resolve(),
    retry: () => state.phase === "retry_ready" ? operation("create") : Promise.resolve(),
    discard: () => { if (alive && !busy && (state.phase === "editing" || state.phase === "retry_ready")) replace({ ownerId: owner, phase: "editing" }); },
    dispose: () => { alive = false; ++generation; ++disposal; controller?.abort(); listeners.clear(); state = { ownerId: owner, phase: "editing" }; },
  });
}

export type ActivityMutationSnapshot = { ownerId: string; activityId: string;
  phase: "editing" | "saving" | "uncertain" | "checking" | "retry_ready" | "saved";
  draft?: ActivityMutationDraft; result?: ActivityMutationResult };
type MutationTransport = { mutate: typeof mutatePersonalActivity; read: typeof readPersonalMutation };
export function createActivityMutationSession(ownerId: string, base: ActivityView, operation: ActivityMutationDraft["operation"],
  transport: MutationTransport = { mutate: mutatePersonalActivity, read: readPersonalMutation }, options: { retainWithoutSubscribers?: boolean } = {}) {
  ActivityMutationOperationSchema.parse(operation);
  const original = parseOwnedActivity(base, ownerId), owner = identity(ownerId);
  let state: ActivityMutationSnapshot = { ownerId: owner, activityId: original.activityId, phase: "editing" };
  const listeners = new Set<(state: ActivityMutationSnapshot) => void>();
  let alive = true, busy = false, generation = 0, disposal = 0, controller: AbortController | null = null;
  const replace = (next: ActivityMutationSnapshot) => { state = next; listeners.forEach(listener => listener(structuredClone(state))); };
  const perform = async (kind: "mutate" | "read") => {
    if (!alive || busy || !state.draft) return;
    busy = true; controller = new AbortController(); const token = ++generation, signal = controller.signal, draft = structuredClone(state.draft);
    replace({ ownerId: owner, activityId: original.activityId, phase: kind === "mutate" ? "saving" : "checking", draft });
    try {
      const value = kind === "mutate" ? await transport.mutate(owner, original, draft, signal) :
        await transport.read(owner, original, draft.input.mutationKey, draft.operation, signal);
      if (!alive || token !== generation || signal.aborted) return;
      const result = parseOwnedMutation(value, owner, original, draft.input.mutationKey, draft.operation);
      replace({ ownerId: owner, activityId: original.activityId, phase: "saved", draft, result });
    } catch (error) {
      if (!alive || token !== generation || signal.aborted) return;
      replace({ ownerId: owner, activityId: original.activityId, phase: kind === "read" && error instanceof ActivitiesApiError && error.status === 404 ? "retry_ready" : "uncertain", draft });
    } finally { if (token === generation) { busy = false; controller = null; } }
  };
  return Object.freeze({ getSnapshot: () => structuredClone(state), getBase: () => structuredClone(original),
    subscribe: (listener: (state: ActivityMutationSnapshot) => void) => {
      if (!alive) return () => {}; ++disposal; listeners.add(listener); listener(structuredClone(state));
      return () => { listeners.delete(listener); const token = ++disposal;
        void Promise.resolve().then(() => { if (token === disposal && !listeners.size && !options.retainWithoutSubscribers) {
          alive = false; ++generation; controller?.abort(); state = { ownerId: owner, activityId: original.activityId, phase: "editing" }; } }); };
    },
    submit: (value: ActivityMutationDraft) => {
      if (!alive || busy || state.phase !== "editing") return Promise.resolve();
      const draft = parsedMutation(value);
      if (draft.operation !== operation || draft.input.expectedStateFingerprint !== original.stateFingerprint) throw new ActivitiesApiError(400);
      state = { ownerId: owner, activityId: original.activityId, phase: "editing", draft: structuredClone(draft) }; return perform("mutate");
    },
    reconcile: () => state.phase === "uncertain" ? perform("read") : Promise.resolve(),
    retry: () => state.phase === "retry_ready" ? perform("mutate") : Promise.resolve(),
    dispose: () => { alive = false; ++generation; ++disposal; controller?.abort(); listeners.clear();
      state = { ownerId: owner, activityId: original.activityId, phase: "editing" }; },
  });
}

export type ActivityEntryMemory = { domain: PersonalDomain; effectivePolicyVersionId: string;
  session: ReturnType<typeof createActivitySubmissionSession> };
export type ActivityMutationMemory = { base: ActivityView; domain: PersonalDomain | null; effectivePolicyVersionId: string | null;
  operation: ActivityMutationDraft["operation"]; session: ReturnType<typeof createActivityMutationSession> };
let activeActivityOwner: string | null = null;
const entries = new Map<string, ActivityEntryMemory>();
const mutations = new Map<string, ActivityMutationMemory>();
/** Called by the authentication gate before another owner's private subtree renders. */
export function bindActivityOwner(ownerId: string | null): void {
  const owner = ownerId === null ? null : identity(ownerId);
  if (owner === activeActivityOwner) return;
  entries.forEach(entry => entry.session.dispose()); mutations.forEach(mutation => mutation.session.dispose());
  entries.clear(); mutations.clear(); activeActivityOwner = owner;
}
export function findActivityEntry(ownerId: string, domainId: string): ActivityEntryMemory | null {
  if (identity(ownerId) !== activeActivityOwner) return null;
  return entries.get(identity(domainId)) ?? null;
}
export function isActivityOwner(ownerId: string): boolean { return ActivityIdSchema.safeParse(ownerId).success && ownerId === activeActivityOwner; }
export function retainActivityEntry(ownerId: string, domain: PersonalDomain, effectivePolicyVersionId: string): ActivityEntryMemory {
  const owner = identity(ownerId), domainId = identity(domain.domainId);
  if (activeActivityOwner !== owner) throw new ActivitiesApiError(401);
  if (domain.policyVersions.some(version => version.configuration.ownerUserId !== owner)) throw new ActivitiesApiError(503);
  const existing = entries.get(domainId); if (existing) return existing;
  const memory = { domain: structuredClone(domain), effectivePolicyVersionId: identity(effectivePolicyVersionId),
    session: createActivitySubmissionSession(owner, undefined, { retainWithoutSubscribers: true }) };
  entries.set(domainId, memory); return memory;
}
export function discardActivityEntry(ownerId: string, domainId: string): boolean {
  const memory = findActivityEntry(ownerId, domainId); if (!memory) return true;
  if (!["editing", "retry_ready", "saved"].includes(memory.session.getSnapshot().phase)) return false;
  memory.session.dispose(); entries.delete(domainId); return true;
}
export function pendingActivityEntries(ownerId: string): { domainId: string; displayName: string }[] {
  if (!isActivityOwner(ownerId)) return [];
  return Array.from(entries.values()).filter(entry => !["editing", "saved"].includes(entry.session.getSnapshot().phase))
    .map(entry => ({ domainId: entry.domain.domainId, displayName: entry.domain.displayName }));
}
export function findActivityMutation(ownerId: string, activityId: string): ActivityMutationMemory | null {
  if (!isActivityOwner(ownerId)) return null; return mutations.get(identity(activityId)) ?? null;
}
export function retainActivityMutation(ownerId: string, base: ActivityView, domain: PersonalDomain | null, effectivePolicyVersionId: string | null,
  operation: ActivityMutationDraft["operation"]): ActivityMutationMemory {
  if (!isActivityOwner(ownerId)) throw new ActivitiesApiError(401);
  const original = parseOwnedActivity(base, ownerId);
  if ((operation === "edit" && !domain) || (domain && (original.domainId !== domain.domainId || domain.policyVersions.some(version => version.configuration.ownerUserId !== ownerId))))
    throw new ActivitiesApiError(503);
  const previous = mutations.get(original.activityId); if (previous) return previous;
  const memory = { base: structuredClone(original), domain: structuredClone(domain), effectivePolicyVersionId, operation,
    session: createActivityMutationSession(ownerId, original, operation, undefined, { retainWithoutSubscribers: true }) };
  mutations.set(original.activityId, memory); return memory;
}
export function discardActivityMutation(ownerId: string, activityId: string): boolean {
  const memory = findActivityMutation(ownerId, activityId); if (!memory) return true;
  if (!["editing", "retry_ready", "saved"].includes(memory.session.getSnapshot().phase)) return false;
  memory.session.dispose(); mutations.delete(activityId); return true;
}
export function pendingActivityMutations(ownerId: string): { activityId: string; displayName: string }[] {
  if (!isActivityOwner(ownerId)) return [];
  return Array.from(mutations.values()).filter(memory => !["editing", "saved"].includes(memory.session.getSnapshot().phase))
    .map(memory => ({ activityId: memory.base.activityId, displayName: memory.base.configuration.displayName }));
}

const wallPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
export function activityLocalTime(instant: string, timezone: string): string | null {
  const parsed = ActivityTimestampSchema.safeParse(instant); if (!parsed.success) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(parsed.data));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}.${parsed.data.slice(20, 23)}`;
  } catch { return null; }
}
/** Reject repeated/skipped DST wall times instead of silently choosing another instant. */
export function activityWallTime(value: string, timezone: string): string | null {
  if (!wallPattern.test(value)) return null;
  const wall = ActivityTimestampSchema.safeParse(value.length === 16 ? `${value}:00Z` : `${value}Z`);
  if (!wall.success || wall.data.slice(0, 16) !== value.slice(0, 16)) return null;
  const wallMs = Date.parse(wall.data), matches = new Set<string>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = new Date(wallMs + hours * 3600000).toISOString(), local = activityLocalTime(sample, timezone);
    if (!local) return null;
    const offset = Date.parse(`${local}Z`) - Date.parse(sample);
    const candidate = new Date(wallMs - offset).toISOString();
    if (activityLocalTime(candidate, timezone) === wall.data.slice(0, -1)) matches.add(candidate);
  }
  return matches.size === 1 ? Array.from(matches)[0] : null;
}
