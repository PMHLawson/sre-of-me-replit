import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainConfigurationSchema } from "@shared/domain-config";
import { ActivityViewSchema, type ActivityMutationResult } from "@shared/activity";
import { ActivitiesApiError, activityConfiguration, activityInput, activityLocalTime, activityWallTime, bindActivityOwner, createActivitySubmissionSession, createPersonalActivity,
  activityEditInput, createActivityMutationSession, discardActivityEntry, discardActivityMutation, findActivityEntry, findActivityMutation,
  mutatePersonalActivity, pendingActivityEntries, pendingActivityMutations, readPersonalMutation, retainActivityEntry, retainActivityMutation,
  parseOwnedActivity, parseOwnedActivityList, personalActivitiesQuery, personalActivityEligibilityQuery, personalActivityQuery, readPersonalSubmission } from "./activities-api";
import { parsePersonalDomain } from "./domains-api";

function activityFixture(owner = "owner-a") {
  const c = DomainConfigurationSchema.parse({ schemaVersion: 1, organizationId: `org-${owner}`, ownerUserId: owner,
    domainId: `domain-${owner}`, policyVersionId: `policy-${owner}`, revision: 1, displayName: "Cooking <own>", effectiveFrom: "2026-01-01T00:00:00Z",
    goal: { intent: "unknown", desiredCapability: "Define later" }, boundary: { timezone: "America/New_York", dayStartHour: 6 }, taskVariants: [],
    measurements: [{ measurementId: "amount", displayName: "Cupcakes", meaning: "Completed cupcakes", role: "practice", comparisonDirection: "higher_is_better",
      kind: "count", valueType: "integer", unit: { unitId: "cupcake", dimension: "count", customLabel: "cupcakes" }, scope: { kind: "per_event" }, aggregation: "sum" }],
    targets: { normal: { targetId: "normal", conditions: [{ measurementId: "amount", unitId: "cupcake", basis: { kind: "per_event" }, valueType: "integer", constraint: { operator: "gte", value: 20 } }] } },
    references: [], review: { anchorAt: "2026-01-01T00:00:00Z", intervalDays: 84 } });
  const input = activityInput(c, "stable-key", "2026-02-01T12:00:00Z", { amount: { unitId: "cupcake", valueType: "integer", raw: "8" } }, "Private <notes>");
  const view = ActivityViewSchema.parse({ activityId: `activity-${owner}`, ownerUserId: owner, domainId: c.domainId, policyVersionId: c.policyVersionId,
    practiceEvent: true, observedAt: input.observedAt, values: input.values, notes: input.notes, deletedAt: null, configuration: c, stateFingerprint: "1".repeat(64),
    scoreAvailability: "not_calculated", attainmentAvailability: "not_calculated" });
  const domain = parsePersonalDomain({ domainId: c.domainId, displayName: c.displayName, slug: "cooking", currentPolicyVersionId: c.policyVersionId,
    policyVersions: [{ configuration: c, referenceComparisons: [] }], scoreAvailability: "not_calculated" }, owner, c.domainId);
  return { c, input, view, domain };
}
const response = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value }) as Response;
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
afterEach(() => { vi.unstubAllGlobals(); bindActivityOwner(null); });

describe("owned typed activity API and draft", () => {
  it("uses exact personal endpoints, credentials and body with no caller authority and one POST", async () => {
    const { input, view, c } = activityFixture(); const fetcher = vi.fn().mockResolvedValue(response({ created: true, submissionKey: input.submissionKey, activity: view }, 201)); vi.stubGlobal("fetch", fetcher);
    await createPersonalActivity("owner-a", input); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/v2/activities");
    const options = fetcher.mock.calls[0][1]; expect(options.credentials).toBe("include"); expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(input); expect(options.body).not.toMatch(/ownerUserId|organizationId|sourceBinding|duration_minutes/);
    fetcher.mockResolvedValueOnce(response({ submissionKey: "key/opaque", activity: view })).mockResolvedValue(response(view)); await readPersonalSubmission("owner-a", "key/opaque");
    expect(fetcher.mock.calls[1][0]).toBe("/api/v2/activities/submissions/key%2Fopaque");
    await personalActivityQuery("owner-a", view.activityId).queryFn({ signal: new AbortController().signal });
    expect(fetcher.mock.calls[2][0]).toBe(`/api/v2/activities/${view.activityId}`);
    fetcher.mockResolvedValue(response({ activities: [view], nextCursor: null }));
    await personalActivitiesQuery("owner-a", { domainId: c.domainId, limit: 25, cursor: "opaque+/=" }).queryFn({ signal: new AbortController().signal });
    expect(fetcher.mock.calls[3][0]).toBe(`/api/v2/activities?limit=25&domainId=${c.domainId}&cursor=opaque%2B%2F%3D`);
  });
  it("owner-partitions list/detail/eligibility and validates individual domain availability", async () => {
    const { c } = activityFixture();
    expect(personalActivitiesQuery("owner-a").queryKey).not.toEqual(personalActivitiesQuery("owner-b").queryKey);
    expect(personalActivityQuery("owner-a", "a").queryKey).not.toEqual(personalActivityEligibilityQuery("owner-a", "a").queryKey);
    const fetcher = vi.fn().mockResolvedValue(response({ domainId: c.domainId, canCreate: true, reason: null, effectivePolicyVersionId: c.policyVersionId })); vi.stubGlobal("fetch", fetcher);
    expect(await personalActivityEligibilityQuery("owner-a", c.domainId).queryFn({ signal: new AbortController().signal })).toMatchObject({ canCreate: true });
    expect(fetcher.mock.calls[0][0]).toBe(`/api/v2/activities/eligibility/${c.domainId}`);
    fetcher.mockResolvedValue(response({ domainId: "foreign-domain", canCreate: true, reason: null, effectivePolicyVersionId: "foreign-policy" }));
    await expect(personalActivityEligibilityQuery("owner-a", c.domainId).queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ status: 503 });
    expect(() => personalActivitiesQuery("__proto__")).toThrow(); expect(() => personalActivitiesQuery("owner-a", { limit: 101 })).toThrow();
  });
  it("rejects foreign, malformed, duplicate, mismatched and fabricated snapshots before use", () => {
    const { view } = activityFixture();
    expect(() => parseOwnedActivity(activityFixture("owner-b").view, "owner-a")).toThrow();
    expect(() => parseOwnedActivity({ ...view, configuration: { ...view.configuration, ownerUserId: "owner-b" } }, "owner-a")).toThrow();
    expect(() => parseOwnedActivity({ ...view, values: { amount: { valueType: "integer", unitId: "minutes", value: 8 } } }, "owner-a")).toThrow();
    expect(() => parseOwnedActivity({ ...view, scoreAvailability: "healthy" }, "owner-a")).toThrow();
    expect(() => parseOwnedActivityList({ activities: [view, view], nextCursor: null }, "owner-a")).toThrow();
    expect(() => parseOwnedActivityList({ activities: [view], nextCursor: null }, "owner-a", "different-domain")).toThrow();
  });
  it("requires a new-create acknowledgement to match submitted typed values and version", async () => {
    const { input, view } = activityFixture(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ created: true, submissionKey: input.submissionKey, activity: { ...view,
      values: { amount: { unitId: "cupcake", valueType: "integer", value: 99 } } } })));
    await expect(createPersonalActivity("owner-a", input)).rejects.toMatchObject({ status: 503 });
  });
  it("requires exact echoed submission identity even when an equal replay now contains a later correction", async () => {
    const { input, view } = activityFixture(), later = { ...view, values: { amount: { ...view.values.amount, value: 12 } }, stateFingerprint: "2".repeat(64) };
    const fetcher = vi.fn().mockResolvedValue(response({ created: false, submissionKey: "unrelated-key", activity: later })); vi.stubGlobal("fetch", fetcher);
    await expect(createPersonalActivity("owner-a", input)).rejects.toMatchObject({ status: 503 });
    fetcher.mockResolvedValue(response({ created: false, submissionKey: input.submissionKey, activity: later }));
    expect((await createPersonalActivity("owner-a", input)).values.amount.value).toBe(12);
    fetcher.mockResolvedValue(response({ submissionKey: "unrelated-key", activity: view }));
    await expect(readPersonalSubmission("owner-a", input.submissionKey)).rejects.toMatchObject({ status: 503 });
    fetcher.mockResolvedValue(response({ submissionKey: input.submissionKey, activity: later }));
    expect((await readPersonalSubmission("owner-a", input.submissionKey)).stateFingerprint).toBe(later.stateFingerprint);
  });
  it("never substitutes targets and preserves zero, false, decimal quantities and missing", () => {
    const { c } = activityFixture();
    expect(activityInput(c, "key", "2026-02-01T12:00:00Z", { amount: { unitId: "cupcake", valueType: "integer", raw: "0" } }, "").values.amount.value).toBe(0);
    expect(() => activityInput(c, "key", "2026-02-01T12:00:00Z", { amount: { unitId: "cupcake", valueType: "integer", raw: "" } }, "")).toThrow();
    for (const raw of ["-1", "8.5", "9007199254740992", "Infinity", "NaN", "1e5"]) expect(() => activityInput(c, "key", "2026-02-01T12:00:00Z",
      { amount: { unitId: "cupcake", valueType: "integer", raw } }, "")).toThrow();
    const boolean = DomainConfigurationSchema.parse({ ...c, measurements: [{ ...c.measurements[0], kind: "completion", valueType: "boolean", comparisonDirection: "equal",
      unit: { unitId: "done", dimension: "boolean" }, aggregation: "any" }], targets: { normal: { targetId: "normal", conditions: [
        { measurementId: "amount", unitId: "done", basis: { kind: "per_event" }, valueType: "boolean", constraint: { operator: "eq", value: true } }] } } });
    expect(activityInput(boolean, "key", "2026-02-01T12:00:00Z", { amount: { unitId: "done", valueType: "boolean", raw: "false" } }, "").values.amount.value).toBe(false);
    const quantity = DomainConfigurationSchema.parse({ ...c, measurements: [{ ...c.measurements[0], kind: "quantity", valueType: "number", unit: { unitId: "kilometre", dimension: "distance" } }], targets: { normal: { targetId: "normal", conditions: [
      { measurementId: "amount", unitId: "kilometre", basis: { kind: "per_event" }, valueType: "number", constraint: { operator: "gte", value: 1 } }] } } });
    expect(activityInput(quantity, "key", "2026-02-01T12:00:00Z", { amount: { unitId: "kilometre", valueType: "number", raw: "1.25" } }, "").values.amount.value).toBe(1.25);
  });
  it("permits an empty event only for a wholly frequency-only configuration", () => {
    const { c } = activityFixture(); const frequency = DomainConfigurationSchema.parse({ ...c, measurements: [{ ...c.measurements[0], measurementId: "frequency-id", kind: "frequency", valueType: "integer",
      unit: { unitId: "days", dimension: "days" }, scope: { kind: "period", windowDays: 7 }, aggregation: "count", countBy: "distinct_days" }], targets: { normal: { targetId: "normal", conditions: [
        { measurementId: "frequency-id", unitId: "days", basis: { kind: "period", windowDays: 7 }, valueType: "integer", constraint: { operator: "gte", value: 3 } }] } } });
    expect(activityInput(frequency, "key", "2026-02-01T12:00:00Z", {}, "").values).toEqual({});
    const mixed = DomainConfigurationSchema.parse({ ...frequency, measurements: [...frequency.measurements, c.measurements[0]] });
    expect(() => activityInput(mixed, "key", "2026-02-01T12:00:00Z", {}, "")).toThrow();
    expect(() => activityInput(frequency, "key", "2026-02-01T12:00:00Z", { "frequency-id": { unitId: "days", valueType: "integer", raw: "3" } }, "")).toThrow();
  });
  it("converts explicit local zones without rounding, rejecting DST gaps, repeats and finer timestamps", () => {
    expect(activityLocalTime("2026-02-01T12:00:00.125Z", "America/New_York")).toBe("2026-02-01T07:00:00.125");
    expect(activityWallTime("2026-02-01T07:00:00.125", "America/New_York")).toBe("2026-02-01T12:00:00.125Z");
    expect(activityWallTime("2026-02-01T17:45", "Asia/Kathmandu")).toBe("2026-02-01T12:00:00.000Z");
    expect(activityWallTime("2026-03-08T02:30", "America/New_York")).toBeNull();
    expect(activityWallTime("2026-11-01T01:30", "America/New_York")).toBeNull();
    for (const bad of ["2026-02-30T12:00", "2026-02-01T12:00:00.0001", "2026-02-01T25:00"]) expect(activityWallTime(bad, "UTC")).toBeNull();
    expect(activityWallTime("2026-02-01T12:00", "Not/A-Timezone")).toBeNull();
  });
  it("selects the exact earlier half-open version and excludes a scheduled successor", () => {
    const { c, domain } = activityFixture(); const next = DomainConfigurationSchema.parse({ ...c, policyVersionId: "next", revision: 2, previousVersionId: c.policyVersionId,
      effectiveFrom: "2026-03-01T00:00:00Z" }); const versions = { ...domain, policyVersions: [...domain.policyVersions, { configuration: next, referenceComparisons: [] }] };
    expect(activityConfiguration(versions, "2026-02-28T23:59:59.999Z", next.policyVersionId)?.policyVersionId).toBe(c.policyVersionId);
    expect(activityConfiguration(versions, "2026-03-01T00:00:00Z", next.policyVersionId)?.policyVersionId).toBe("next");
    expect(activityConfiguration(versions, "2026-03-01T00:00:00Z", c.policyVersionId)).toBeNull();
    expect(activityConfiguration(versions, "2025-12-31T23:59:59Z", next.policyVersionId)).toBeNull();
    expect(activityConfiguration(versions, "2026-02-01T00:00:00.0001Z", next.policyVersionId)).toBeNull();
  });
});

describe("owned correction and reversible lifecycle protocol", () => {
  function editFixture() {
    const { view, c, domain } = activityFixture(); const input = activityEditInput(view, c, "mutation-key", "Correct the count", view.observedAt,
      { amount: { unitId: "cupcake", valueType: "integer", raw: "0" } }, "Corrected notes", "Own context");
    const after = { ...view, observedAt: input.observedAt, values: input.values, notes: input.notes, context: input.context, stateFingerprint: "2".repeat(64) };
    const result: ActivityMutationResult = { changed: true, operation: "edit", mutationKey: input.mutationKey, activity: after, appliedStateFingerprint: after.stateFingerprint };
    return { view, c, domain, input, after, result };
  }
  it("uses strict own PATCH/delete/restore endpoints and manual mutation GET, without authority fields or automatic retry", async () => {
    const { view, input, result } = editFixture(); const fetcher = vi.fn().mockResolvedValue(response(result)); vi.stubGlobal("fetch", fetcher);
    await mutatePersonalActivity("owner-a", view, { operation: "edit", input });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toBe(`/api/v2/activities/${view.activityId}`);
    expect(fetcher.mock.calls[0][1].method).toBe("PATCH"); expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(input);
    expect(fetcher.mock.calls[0][1].body).not.toMatch(/ownerUserId|organizationId|submissionKey|domainId|activityId/);
    const life = { mutationKey: "life-key", expectedStateFingerprint: view.stateFingerprint, reason: "Keep correction history" };
    for (const operation of ["delete", "restore"] as const) {
      fetcher.mockResolvedValue(response({ ...result, operation, mutationKey: life.mutationKey,
        activity: { ...view, stateFingerprint: result.appliedStateFingerprint, deletedAt: operation === "delete" ? "2026-02-02T12:00:00Z" : null } }));
      await mutatePersonalActivity("owner-a", view, { operation, input: life });
      expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/v2/activities/${view.activityId}/${operation}`);
      expect(fetcher.mock.calls.at(-1)?.[1].method).toBe("POST");
    }
    fetcher.mockResolvedValue(response({ ...result, changed: false })); await readPersonalMutation("owner-a", view, input.mutationKey, "edit");
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(`/api/v2/activities/${view.activityId}/mutations/mutation-key`);
    expect(fetcher.mock.calls.at(-1)?.[1].method).toBeUndefined();
  });
  it("rejects a newly applied lifecycle acknowledgement that silently changes raw work or historical configuration", async () => {
    const { view, result } = editFixture(), input = { mutationKey: "delete-key", expectedStateFingerprint: view.stateFingerprint, reason: "Reversible deletion" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...result, operation: "delete", mutationKey: input.mutationKey,
      activity: { ...result.activity, deletedAt: "2026-02-02T12:00:00Z" } })));
    await expect(mutatePersonalActivity("owner-a", view, { operation: "delete", input })).rejects.toMatchObject({ status: 503 });
  });
  it("refuses blank reason, caller authority, wrong key/operation/activity and malformed fingerprint", async () => {
    const { view, input, result } = editFixture(); const fetcher = vi.fn().mockResolvedValue(response(result)); vi.stubGlobal("fetch", fetcher);
    await expect(mutatePersonalActivity("owner-a", view, { operation: "edit", input: { ...input, reason: " " } })).rejects.toThrow();
    await expect(mutatePersonalActivity("owner-a", view, { operation: "edit", input: { ...input, domainId: "foreign" } as typeof input })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    for (const bad of [{ ...result, mutationKey: "different" }, { ...result, operation: "restore" },
      { ...result, activity: { ...result.activity, activityId: "unrelated-activity" } }, { ...result, appliedStateFingerprint: "bad" }]) {
      fetcher.mockResolvedValue(response(bad)); await expect(mutatePersonalActivity("owner-a", view, { operation: "edit", input })).rejects.toMatchObject({ status: 503 });
    }
  });
  it("preserves saved task conditions and immutable event domain while permitting below-target zero", () => {
    const { view, c } = editFixture(), original = { ...view, context: { description: "Old", taskConditions: [{ conditionId: "equipment", description: "Same equipment" }] } };
    const draft = activityEditInput(original, c, "key", "Changed reason", view.observedAt, { amount: { unitId: "cupcake", valueType: "integer", raw: "0" } }, "", "");
    expect(draft.values.amount.value).toBe(0); expect(draft.context).toEqual({ taskConditions: original.context.taskConditions });
    expect(draft).not.toHaveProperty("domainId"); expect(draft.expectedStateFingerprint).toBe(view.stateFingerprint);
    expect(() => activityEditInput(original, { ...c, domainId: "different" }, "key", "reason", view.observedAt, {}, "", "")).toThrow();
  });
  it("reconciles an original applied change against the current event after later changes without replaying", async () => {
    const { view, input, result } = editFixture(), current = { ...result.activity, deletedAt: "2026-02-03T12:00:00.000Z", stateFingerprint: "3".repeat(64) };
    const mutate = vi.fn().mockRejectedValue(new ActivitiesApiError(503)), read = vi.fn().mockResolvedValue({ ...result, changed: false, activity: current });
    const session = createActivityMutationSession("owner-a", view, "edit", { mutate, read });
    await session.submit({ operation: "edit", input }); await session.submit({ operation: "edit", input: { ...input, mutationKey: "new-key" } });
    expect(mutate).toHaveBeenCalledTimes(1); expect(session.getSnapshot()).toMatchObject({ phase: "uncertain", draft: { input: { mutationKey: "mutation-key", expectedStateFingerprint: view.stateFingerprint } } });
    await session.reconcile(); expect(read).toHaveBeenCalledExactlyOnceWith("owner-a", expect.objectContaining({ activityId: view.activityId }), "mutation-key", "edit", expect.any(AbortSignal));
    expect(session.getSnapshot()).toMatchObject({ phase: "saved", result: { appliedStateFingerprint: "2".repeat(64), activity: { stateFingerprint: "3".repeat(64), deletedAt: current.deletedAt } } });
    await session.retry(); expect(mutate).toHaveBeenCalledTimes(1);
  });
  it("does not infer absence from failed mutation reads or silently rebase a conflict", async () => {
    const { view, input, result } = editFixture(), mutate = vi.fn().mockRejectedValueOnce(new ActivitiesApiError(400)).mockResolvedValue(result);
    const read = vi.fn().mockRejectedValueOnce(new ActivitiesApiError(503)).mockRejectedValueOnce(new ActivitiesApiError(404));
    const session = createActivityMutationSession("owner-a", view, "edit", { mutate, read }); await session.submit({ operation: "edit", input });
    await session.reconcile(); await session.retry(); expect(mutate).toHaveBeenCalledTimes(1); expect(session.getSnapshot().phase).toBe("uncertain");
    await session.reconcile(); expect(session.getSnapshot().phase).toBe("retry_ready"); await session.retry();
    expect(mutate.mock.calls[1][2]).toEqual({ operation: "edit", input }); expect(session.getSnapshot().phase).toBe("saved");
  });
  it("retains lifecycle drafts across same-owner pages, but account departure aborts and quarantines late results", async () => {
    const { view, domain, result } = editFixture(); bindActivityOwner("owner-a"); const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal("fetch", fetcher);
    const memory = retainActivityMutation("owner-a", view, domain, view.policyVersionId, "delete"), leave = memory.session.subscribe(vi.fn());
    const input = { mutationKey: "delete-key", expectedStateFingerprint: view.stateFingerprint, reason: "Reversible correction" };
    const action = memory.session.submit({ operation: "delete", input }); leave(); await Promise.resolve();
    expect(findActivityMutation("owner-a", view.activityId)).toBe(memory); expect(discardActivityMutation("owner-a", view.activityId)).toBe(false);
    expect(pendingActivityMutations("owner-a")).toEqual([{ activityId: view.activityId, displayName: view.configuration.displayName }]);
    bindActivityOwner("owner-b"); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    pending.resolve(response({ ...result, operation: "delete", mutationKey: input.mutationKey, activity: { ...result.activity, deletedAt: "2026-02-02T12:00:00Z" } })); await action;
    expect(findActivityMutation("owner-a", view.activityId)).toBeNull(); expect(pendingActivityMutations("owner-b")).toEqual([]);
    expect(memory.session.getSnapshot()).toEqual({ ownerId: "owner-a", activityId: view.activityId, phase: "editing" });
  });
  it("survives correction subscription replay without a duplicate request and never sends on cancellation", async () => {
    const { view, input, result } = editFixture(), held = deferred<ActivityMutationResult>(), mutate = vi.fn().mockReturnValue(held.promise);
    const session = createActivityMutationSession("owner-a", view, "edit", { mutate, read: vi.fn() });
    const leave = session.subscribe(vi.fn()), action = session.submit({ operation: "edit", input }); leave();
    const leaveAgain = session.subscribe(vi.fn()); await Promise.resolve(); expect(mutate.mock.calls[0][3].aborted).toBe(false);
    await session.submit({ operation: "edit", input }); expect(mutate).toHaveBeenCalledTimes(1);
    held.resolve(result); await action; leaveAgain(); await Promise.resolve(); expect(session.getSnapshot().phase).toBe("editing");
    const cancelled = createActivityMutationSession("owner-a", view, "delete", { mutate, read: vi.fn() }); cancelled.dispose();
    await cancelled.submit({ operation: "delete", input: { mutationKey: "cancelled", expectedStateFingerprint: view.stateFingerprint, reason: "No change" } });
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("imperative activity submission lifetime", () => {
  it("holds one POST/key/draft before rendering and resolves an uncertain save through owned read", async () => {
    const { input, view } = activityFixture(); const post = deferred<typeof view>();
    const create = vi.fn().mockReturnValue(post.promise), read = vi.fn().mockResolvedValue(view);
    const session = createActivitySubmissionSession("owner-a", { create, read });
    const first = session.submit(input); const duplicate = session.submit({ ...input, submissionKey: "different-key" });
    expect(session.getSnapshot()).toMatchObject({ phase: "saving", draft: { submissionKey: "stable-key" } }); expect(create).toHaveBeenCalledTimes(1);
    post.reject(new ActivitiesApiError(503)); await Promise.all([first, duplicate]); expect(session.getSnapshot().phase).toBe("uncertain");
    await session.retry(); expect(create).toHaveBeenCalledTimes(1); await session.reconcile();
    expect(read).toHaveBeenCalledExactlyOnceWith("owner-a", "stable-key", expect.any(AbortSignal)); expect(session.getSnapshot().phase).toBe("saved");
  });
  it("failed saved read is never absence; only explicit owned404 offers a deliberate equal retry", async () => {
    const { input, view } = activityFixture(); const create = vi.fn().mockRejectedValueOnce(new ActivitiesApiError(503)).mockResolvedValue(view);
    const read = vi.fn().mockRejectedValueOnce(new ActivitiesApiError(503)).mockRejectedValueOnce(new ActivitiesApiError(404));
    const session = createActivitySubmissionSession("owner-a", { create, read }); await session.submit(input); await session.reconcile();
    expect(session.getSnapshot().phase).toBe("uncertain"); session.discard(); await session.retry(); expect(create).toHaveBeenCalledTimes(1);
    await session.reconcile(); expect(session.getSnapshot().phase).toBe("retry_ready"); await session.retry();
    expect(create).toHaveBeenCalledTimes(2); expect(create.mock.calls[1][1]).toEqual(input); expect(session.getSnapshot().phase).toBe("saved");
  });
  it("quarantines late held A success and failure after owner disposal; B stays independent", async () => {
    for (const success of [true, false]) {
      const a = activityFixture(), b = activityFixture("owner-b"), held = deferred<typeof a.view>();
      const createA = vi.fn().mockReturnValue(held.promise), listener = vi.fn();
      const A = createActivitySubmissionSession("owner-a", { create: createA, read: vi.fn() }); A.subscribe(listener); const pending = A.submit(a.input);
      const signal = createA.mock.calls[0][2]; A.dispose(); expect(signal.aborted).toBe(true);
      const B = createActivitySubmissionSession("owner-b", { create: vi.fn().mockResolvedValue(b.view), read: vi.fn() }); await B.submit(b.input);
      const calls = listener.mock.calls.length; success ? held.resolve(a.view) : held.reject(new ActivitiesApiError(503)); await pending;
      expect(listener.mock.calls.length).toBe(calls); expect(A.getSnapshot()).toEqual({ ownerId: "owner-a", phase: "editing" });
      expect(B.getSnapshot()).toMatchObject({ phase: "saved", activity: { ownerUserId: "owner-b", values: { amount: { value: 8 } } } });
    }
  });
  it("survives StrictMode subscription cleanup replay without a second POST, then disposes on real departure", async () => {
    const { input, view } = activityFixture(); const held = deferred<typeof view>(), create = vi.fn().mockReturnValue(held.promise);
    const session = createActivitySubmissionSession("owner-a", { create, read: vi.fn() }); const leave = session.subscribe(vi.fn());
    const pending = session.submit(input); leave(); const leaveAgain = session.subscribe(vi.fn()); await Promise.resolve();
    expect(create.mock.calls[0][2].aborted).toBe(false); await session.submit(input); expect(create).toHaveBeenCalledTimes(1);
    held.resolve(view); await pending; expect(session.getSnapshot().phase).toBe("saved"); leaveAgain(); await Promise.resolve();
    expect(session.getSnapshot()).toEqual({ ownerId: "owner-a", phase: "editing" });
  });
  it("retains an uncertain key and opening policy across same-owner route departure, then clears on account change", async () => {
    const { domain, input, c } = activityFixture(); bindActivityOwner("owner-a");
    const fetcher = vi.fn().mockRejectedValue(new Error("lost acknowledgement")); vi.stubGlobal("fetch", fetcher);
    const entry = retainActivityEntry("owner-a", domain, c.policyVersionId), leave = entry.session.subscribe(vi.fn());
    await entry.session.submit(input); leave(); await Promise.resolve();
    const returned = findActivityEntry("owner-a", domain.domainId);
    expect(returned).toBe(entry); expect(returned?.session.getSnapshot()).toMatchObject({ phase: "uncertain", draft: input });
    expect(retainActivityEntry("owner-a", { ...domain, displayName: "Changed latest" }, "different")).toBe(entry);
    expect(discardActivityEntry("owner-a", domain.domainId)).toBe(false);
    expect(pendingActivityEntries("owner-a")).toEqual([{ domainId: domain.domainId, displayName: domain.displayName }]);
    expect(fetcher).toHaveBeenCalledTimes(1); bindActivityOwner("owner-b");
    expect(findActivityEntry("owner-a", domain.domainId)).toBeNull(); expect(pendingActivityEntries("owner-b")).toEqual([]);
    expect(entry.session.getSnapshot()).toEqual({ ownerId: "owner-a", phase: "editing" });
    bindActivityOwner("owner-a"); expect(findActivityEntry("owner-a", domain.domainId)).toBeNull();
  });
});
