import { z } from "zod";
import { OnboardingSettingsSchema, OnboardingStatusSchema, type OnboardingReady,
  type OnboardingSettings, type OnboardingStatus } from "@shared/onboarding";

const identity = z.string().min(1).max(200).refine(value => value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value) && value !== "__proto__");
export const ONBOARDING_QUERY = "personal-onboarding";
export class OnboardingApiError extends Error {
  constructor(public readonly status: number, public readonly needsReconciliation = false) {
    super(needsReconciliation ? "The outcome is uncertain. Check your saved workspace before trying again." :
      status === 401 ? "Sign in to continue." : status === 403 ? "Your workspace access could not be verified." :
      status === 400 ? "Review your day settings." : "Your workspace could not be verified. Please try again.");
    this.name = "OnboardingApiError";
  }
}
function ownerIdentity(ownerId: string): string {
  const parsed = identity.safeParse(ownerId);
  if (!parsed.success) throw new OnboardingApiError(401);
  return parsed.data;
}
export function parseOnboardingStatus(value: unknown, ownerId: string): OnboardingStatus {
  const owner = ownerIdentity(ownerId), parsed = OnboardingStatusSchema.safeParse(value);
  if (!parsed.success || parsed.data.ownerUserId !== owner) throw new OnboardingApiError(503);
  return parsed.data;
}
export function parsePersonalDaySettings(value: unknown, ownerId: string): OnboardingSettings {
  const owner = ownerIdentity(ownerId);
  // /api/settings contains unrelated settings. Copy only the declared day fields.
  const fields = z.object({ userId: z.unknown(), dayStartHour: z.unknown(), timezone: z.unknown(), windowDays: z.unknown() })
    .safeParse(value);
  const parsed = OnboardingSettingsSchema.safeParse(fields.success ? fields.data : null);
  if (!parsed.success || parsed.data.userId !== owner) throw new OnboardingApiError(503);
  return parsed.data;
}
async function request(path: string, signal: AbortSignal, method = "GET", body?: object): Promise<unknown> {
  let response: Response;
  const write = method !== "GET";
  try { response = await fetch(path, { method, credentials: "include", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }); }
  catch { throw new OnboardingApiError(503, write); }
  if (!response.ok) throw new OnboardingApiError(response.status,
    write && (response.status >= 500 || response.status === 408));
  try { return await response.json(); } catch { throw new OnboardingApiError(503, write); }
}
export function onboardingStatusQuery(ownerId: string) {
  const owner = ownerIdentity(ownerId);
  return { queryKey: [ONBOARDING_QUERY, owner, "status"] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) =>
      parseOnboardingStatus(await request("/api/onboarding/status", signal), owner),
    staleTime: 0, gcTime: 0, retry: false as const };
}
/** One call, empty body. No actor, organization, template or role is sent. */
export async function ensurePersonalWorkspace(ownerId: string, signal: AbortSignal): Promise<OnboardingReady> {
  const owner = ownerIdentity(ownerId);
  try {
    const status = parseOnboardingStatus(await request("/api/onboarding/workspace", signal, "POST", {}), owner);
    if (status.status !== "ready") throw new OnboardingApiError(503, true);
    return status;
  } catch (error) {
    if (error instanceof OnboardingApiError && !error.needsReconciliation && [400, 401, 403, 404].includes(error.status)) throw error;
    throw new OnboardingApiError(503, true);
  }
}
const dayPatch = z.object({ dayStartHour: z.number().int().min(0).max(23).optional(),
  timezone: OnboardingSettingsSchema.shape.timezone.optional(),
  windowDays: z.union([z.literal(7), z.literal(14), z.literal(28), z.literal(42)]).optional() })
  .strict().refine(value => Object.keys(value).length > 0);
export type PersonalDaySettingsPatch = z.infer<typeof dayPatch>;
export async function savePersonalDaySettings(ownerId: string, input: PersonalDaySettingsPatch,
  signal: AbortSignal): Promise<OnboardingSettings> {
  const owner = ownerIdentity(ownerId), parsed = dayPatch.safeParse(input);
  if (!parsed.success) throw new OnboardingApiError(400);
  try {
    const saved = parsePersonalDaySettings(await request("/api/settings", signal, "PATCH", parsed.data), owner);
    if (Object.entries(parsed.data).some(([field, value]) => saved[field as keyof OnboardingSettings] !== value))
      throw new OnboardingApiError(503, true);
    return saved;
  }
  catch (error) {
    if (error instanceof OnboardingApiError && !error.needsReconciliation && [400, 401, 403, 404].includes(error.status)) throw error;
    throw new OnboardingApiError(503, true);
  }
}

export type WorkspaceEntrySnapshot = { ownerId: string; phase: "checking" | "provisioning" | "uncertain" | "retry_ready" | "error";
  message?: string } | { ownerId: string; phase: "ready"; status: OnboardingReady };
type EntryTransport = { read: (ownerId: string, signal: AbortSignal) => Promise<OnboardingStatus>;
  ensure: (ownerId: string, signal: AbortSignal) => Promise<OnboardingReady> };
/** Owner-lifetime state machine used by the actual app gate, with no mutation/cache retry. */
export function createWorkspaceEntrySession(ownerId: string, transport: EntryTransport = {
  read: (owner, signal) => onboardingStatusQuery(owner).queryFn({ signal }), ensure: ensurePersonalWorkspace,
}) {
  const owner = ownerIdentity(ownerId);
  let snapshot: WorkspaceEntrySnapshot = { ownerId: owner, phase: "checking" };
  let started = false, disposed = false, pending = false, attempted = false, lease = 0;
  let controller: AbortController | undefined;
  const listeners = new Set<(state: WorkspaceEntrySnapshot) => void>();
  const emit = (next: WorkspaceEntrySnapshot) => {
    if (disposed) return;
    snapshot = next;
    listeners.forEach(listener => listener(next));
  };
  const owned = (status: OnboardingStatus) => parseOnboardingStatus(status, owner);
  const ensure = async () => {
    attempted = true; pending = true; controller = new AbortController();
    emit({ ownerId: owner, phase: "provisioning" });
    try {
      const status = owned(await transport.ensure(owner, controller.signal));
      if (status.status !== "ready") throw new OnboardingApiError(503, true);
      emit({ ownerId: owner, phase: "ready", status });
    } catch (error) {
      const failure = error instanceof OnboardingApiError ? error : new OnboardingApiError(503, true);
      emit({ ownerId: owner, phase: failure.needsReconciliation ? "uncertain" : "error", message: failure.message });
    } finally { pending = false; }
  };
  const read = async (initial: boolean) => {
    if (disposed || pending) return;
    pending = true; controller = new AbortController(); emit({ ownerId: owner, phase: "checking" });
    let provision = false;
    try {
      const status = owned(await transport.read(owner, controller.signal));
      if (status.status === "ready") emit({ ownerId: owner, phase: "ready", status });
      else if (initial && !attempted && !disposed) provision = true;
      else emit({ ownerId: owner, phase: "retry_ready" });
    } catch (error) {
      const failure = error instanceof OnboardingApiError ? error : new OnboardingApiError(503);
      emit({ ownerId: owner, phase: "error", message: failure.message });
    } finally { pending = false; }
    if (provision && !disposed) await ensure();
  };
  const dispose = () => { disposed = true; controller?.abort(); listeners.clear(); snapshot = { ownerId: owner, phase: "checking" }; };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (state: WorkspaceEntrySnapshot) => void) {
      if (disposed) return () => {};
      lease++; listeners.add(listener); listener(snapshot);
      return () => {
        listeners.delete(listener); const released = ++lease;
        // React's development effect replay subscribes again synchronously.
        // A genuine owner departure aborts before the next asynchronous completion.
        queueMicrotask(() => { if (lease === released && listeners.size === 0) dispose(); });
      };
    },
    async start() { if (started || disposed) return; started = true; await read(true); },
    async reconcile() { await read(false); },
    async retryEnsure() {
      if (!disposed && !pending && snapshot.phase === "retry_ready") await ensure();
    },
    dispose,
  };
}
