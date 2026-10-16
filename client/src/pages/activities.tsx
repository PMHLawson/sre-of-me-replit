import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { ActivityIdSchema, ActivityLifecycleInputSchema, type ActivityEligibility, type ActivityView } from "@shared/activity";
import { type DomainConfiguration } from "@shared/domain-config";
import { personalDomainsQuery, type PersonalDomain } from "@/lib/domains-api";
import { PERSONAL_ACTIVITIES_QUERY, activityConfiguration, activityInput, activityLocalTime, activityWallTime, createActivitySubmissionSession,
  activityEditInput, discardActivityEntry, discardActivityMutation, findActivityEntry, findActivityMutation, isActivityOwner,
  pendingActivityEntries, pendingActivityMutations, retainActivityEntry, retainActivityMutation,
  personalActivitiesQuery, personalActivityEligibilityQuery, personalActivityQuery,
  type ActivityEntryMemory, type ActivityMutationMemory, type ActivityMutationSnapshot, type ActivityField, type ActivitySubmissionSnapshot } from "@/lib/activities-api";
import { PersonalConfigurationView } from "./domain-settings";

const panel = "rounded-xl border border-border bg-card p-4 space-y-3";
const button = "rounded-lg border border-border px-4 py-2 font-semibold disabled:opacity-50";
const input = "w-full rounded-lg border border-border bg-background p-3";
export function ActivityAvailability({ availability, domainId }: { availability: ActivityEligibility; domainId: string }) {
  if (availability.canCreate) return <p className="text-sm text-muted-foreground">Your domain is available for activity entry. The saved version and event time are checked again when you save.</p>;
  return <section className={panel} role="status" data-testid={`activity-${availability.reason}`}>
    <p>{availability.reason === "legacy_writer" ? "This domain uses your original session logger." :
      availability.reason === "inactive" ? "This domain is inactive. New activity cannot be added." :
      "No configuration has taken effect yet. Scheduled configurations cannot be used for activity entry."}</p>
    {availability.reason === "legacy_writer" && <Link href="/log" className="underline">Open the original logger</Link>}
    <Link href={`/domains/${encodeURIComponent(domainId)}`} className="underline block">Back to this domain</Link>
  </section>;
}
export function ActivityRawView({ activity }: { activity: ActivityView }) {
  const c = activity.configuration;
  return <article className={panel} data-testid="activity-raw-view">
    <h2 className="text-xl font-semibold break-words">{c.displayName}</h2>
    <p><strong>Occurred:</strong> {activity.observedAt}</p>
    <p>Saved version {c.revision} · day begins {String(c.boundary.dayStartHour).padStart(2, "0")}:00 in {c.boundary.timezone}</p>
    {activity.deletedAt && <p role="status">This activity is deleted. Its saved record remains available.</p>}
    <ul className="space-y-2">{c.measurements.map(m => {
      const value = activity.values[m.measurementId];
      return <li key={m.measurementId}><strong>{m.displayName}:</strong> {m.kind === "frequency" ?
        "Frequency and qualification not calculated" : value === undefined ? "Not recorded" :
        `${value.valueType === "boolean" ? value.value ? "Yes" : "No" : String(value.value)} ${m.unit.customLabel ?? m.unit.unitId}`}
        {m.taskVariantId && <span> · {c.taskVariants.find(v => v.variantId === m.taskVariantId)?.displayName}</span>}</li>;
    })}</ul>
    {!Object.keys(activity.values).length && <p>Practice event recorded. No duration or quantity has been invented.</p>}
    {activity.notes !== undefined && <p className="whitespace-pre-wrap break-words"><strong>Notes:</strong> {activity.notes}</p>}
    {activity.context?.description && <p className="whitespace-pre-wrap break-words"><strong>Context:</strong> {activity.context.description}</p>}
    {activity.context?.taskConditions?.map(condition => <p key={condition.conditionId}>{condition.description}</p>)}
    <p className="text-sm text-muted-foreground">Raw work is saved even below a declared target or reference. No activity score, qualification result or benefit has been inferred.</p>
    <details><summary className="cursor-pointer font-semibold">View this activity's saved configuration and references</summary>
      <div className="mt-4"><PersonalConfigurationView version={{ configuration: c, referenceComparisons: [] }}/></div></details>
  </article>;
}
type EntryProps = { ownerId: string; domain: PersonalDomain; effectivePolicyVersionId: string; availableNow?: boolean;
  reload: () => void; restart?: () => void; entry?: ActivityEntryMemory; onSaved?: (activity: ActivityView) => void;
  initialAt?: string; initialKey?: string; initialTimezone?: string };
export function ActivityEntryForm({ ownerId, domain, effectivePolicyVersionId, availableNow = true, reload, onSaved,
  restart, entry, initialAt, initialKey, initialTimezone }: EntryProps) {
  const session = useMemo(() => entry?.session ?? createActivitySubmissionSession(ownerId), [entry, ownerId, domain.domainId]);
  const [snapshot, setSnapshot] = useState<ActivitySubmissionSnapshot>(() => session.getSnapshot());
  const [localZone] = useState(() => initialTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [timezone, setTimezone] = useState(localZone);
  const [when, setWhen] = useState(() => activityLocalTime(session.getSnapshot().draft?.observedAt ?? initialAt ?? new Date().toISOString(), timezone) ?? "");
  const [submissionKey, setSubmissionKey] = useState(() => session.getSnapshot().draft?.submissionKey ?? initialKey ?? crypto.randomUUID());
  const [fields, setFields] = useState<Record<string, ActivityField>>(() => Object.fromEntries(Object.entries(session.getSnapshot().draft?.values ?? {})
    .map(([id, value]) => [id, { unitId: value.unitId, valueType: value.valueType, ...(value.taskVariantId ? { taskVariantId: value.taskVariantId } : {}), raw: String(value.value) }])));
  const [notes, setNotes] = useState(() => session.getSnapshot().draft?.notes ?? "");
  const [context, setContext] = useState(() => session.getSnapshot().draft?.context?.description ?? ""); const [message, setMessage] = useState("");
  const ownerRef = useRef(ownerId); ownerRef.current = ownerId;
  useEffect(() => session.subscribe(setSnapshot), [session]);
  const current = snapshot.ownerId === ownerId ? snapshot : { ownerId, phase: "editing" as const };
  const at = activityWallTime(when, timezone), configuration = at ? activityConfiguration(domain, at, effectivePolicyVersionId) : null;
  const versionRef = useRef(configuration?.policyVersionId);
  useEffect(() => {
    if (versionRef.current !== configuration?.policyVersionId) {
      versionRef.current = configuration?.policyVersionId; setFields({});
      setMessage("The selected saved version changed. Enter its measurements again; no units or quantities were converted.");
    }
  }, [configuration?.policyVersionId]);
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (current.phase === "saved" && current.activity && ownerRef.current === ownerId && notified.current !== current.activity.activityId) {
      notified.current = current.activity.activityId; onSaved?.(current.activity);
    }
  }, [current, ownerId, onSaved]);
  const paused = current.phase !== "editing", pending = current.phase === "saving" || current.phase === "checking";
  const change = (m: DomainConfiguration["measurements"][number], raw: string) => setFields(previous => ({ ...previous,
    [m.measurementId]: { unitId: m.unit.unitId, valueType: m.valueType, ...(m.taskVariantId ? { taskVariantId: m.taskVariantId } : {}), raw } }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); if (session.getSnapshot().phase !== "editing" || !availableNow || !configuration || !at) return;
    try { const draft = activityInput(configuration, submissionKey, at, fields, notes, context); setMessage(""); void session.submit(draft); }
    catch { setMessage("Enter at least one declared practice amount, using its exact unit and a valid nonnegative value. Leave missing values blank. Frequency-only domains can record the event alone."); }
  };
  const discard = () => {
    if (session.getSnapshot().phase !== "editing" && session.getSnapshot().phase !== "retry_ready") return;
    session.discard(); setSubmissionKey(crypto.randomUUID()); setFields({}); setNotes(""); setContext(""); setMessage("");
    if (restart) restart(); else reload();
  };
  if (domain.policyVersions.some(version => version.configuration.ownerUserId !== ownerId) ||
    (entry && entry.session.getSnapshot().ownerId !== ownerId)) return null;
  if (current.phase === "saved" && current.activity) return <div className="space-y-4"><p role="status">Activity saved.</p>
    <ActivityRawView activity={current.activity}/><Link href={`/activities/${encodeURIComponent(current.activity.activityId)}`} className="underline">Open saved activity</Link>
    <Link href={`/activities/domain/${encodeURIComponent(domain.domainId)}`} className="underline block">View this domain's activity history</Link>
    <Link href={`/domains/${encodeURIComponent(domain.domainId)}`} className="underline block">Back to this domain</Link></div>;
  return <section className="space-y-4" data-testid="activity-entry-form">
    {!paused && <Link href={`/domains/${encodeURIComponent(domain.domainId)}`} className="underline">Cancel and return to this domain</Link>}
    {paused && <p className="text-sm text-muted-foreground">Further saves for this draft are paused until this request is resolved. If you leave this page, return to this domain's entry to check it. Keep this tab open; this private draft is held in memory, not saved across a reload. Changing accounts clears it; check your own activity history when you return before logging again.</p>}
    {current.phase === "uncertain" && <div className={panel} role="alert"><p>This save was not acknowledged. It may already be saved. Keep this draft and check its saved activity before trying again.</p>
      <button type="button" className={button} onClick={() => { void session.reconcile(); }}>Check saved activity</button></div>}
    {current.phase === "retry_ready" && <div className={panel} role="status"><p>Your own saved read found no activity under this submission key. You may deliberately retry the same draft or discard it.</p>
      <button type="button" className={button} disabled={!availableNow} onClick={() => { void session.retry(); }}>Retry this same activity</button>
      <button type="button" className={`${button} ml-2`} onClick={discard}>Discard draft and refresh</button></div>}
    {pending && <p role="status">{current.phase === "saving" ? "Saving your activity…" : "Checking the saved activity…"}</p>}
    {!availableNow && <p role="alert">Domain availability could not be verified for a new save. Refresh it; this draft stays here.</p>}
    <button type="button" className={button} disabled={pending} onClick={reload}>Refresh domain availability</button>
    {current.phase === "editing" && <button type="button" className={`${button} ml-2`} onClick={discard}>Discard draft and refresh</button>}
    <form onSubmit={submit} className={panel}>
      <fieldset disabled={paused} className="space-y-4">
        <h2 className="text-xl font-semibold">Record {domain.displayName}</h2>
        <label className="block">Time zone for this entry<select className={input} value={timezone} onChange={event => {
          const zone = event.target.value; setWhen(at ? activityLocalTime(at, zone) ?? "" : ""); setTimezone(zone);
        }}><option value={localZone}>Local time · {localZone}</option>{localZone !== "UTC" && <option value="UTC">UTC</option>}</select></label>
        <label className="block">When did this happen? ({timezone})<input className={input} type="datetime-local" step="0.001" value={when}
          onChange={event => setWhen(event.target.value)} required/></label>
        <p className="text-sm text-muted-foreground">Enter the event time in {timezone}. For a repeated daylight-saving hour, choose UTC and enter its exact time. Each saved version keeps its own day boundary.</p>
        {configuration ? <><p>Selected saved version {configuration.revision}. Day begins {String(configuration.boundary.dayStartHour).padStart(2, "0")}:00 in {configuration.boundary.timezone}.</p>
          {configuration.measurements.filter(m => m.kind !== "frequency" && m.scope.kind === "per_event").map(m => <label className="block" key={m.measurementId}>
            {m.displayName} · {m.unit.customLabel ?? m.unit.unitId}{m.taskVariantId ? ` · ${configuration.taskVariants.find(v => v.variantId === m.taskVariantId)?.displayName}` : ""}
            {m.valueType === "boolean" ? <select className={input} value={fields[m.measurementId]?.raw ?? ""} onChange={event => change(m, event.target.value)}>
              <option value="">Not recorded</option><option value="true">Yes</option><option value="false">No</option></select> :
              <input className={input} type="number" min="0" step={m.valueType === "integer" ? "1" : "any"} value={fields[m.measurementId]?.raw ?? ""}
                onChange={event => change(m, event.target.value)}/>}<span className="text-sm text-muted-foreground">{m.meaning} · blank means not recorded</span>
          </label>)}
          {configuration.measurements.every(m => m.kind === "frequency") && <p>Record one practice event. Event/day totals and qualification are not calculated here.</p>}
          {configuration.measurements.some(m => m.kind !== "frequency" && m.scope.kind === "period") && <p>Period-summary measurements are not entered as a single event. Only supported per-event raw values can be recorded here.</p>}
        </> : <p role="alert">Choose a valid, unambiguous local time covered by an already-effective saved version. Scheduled configurations cannot be used.</p>}
        <label className="block">Notes (optional)<textarea className={input} maxLength={4000} value={notes} onChange={event => setNotes(event.target.value)}/></label>
        <label className="block">Practice context (optional)<textarea className={input} maxLength={2000} value={context} onChange={event => setContext(event.target.value)}/></label>
      </fieldset>
      {message && <p role="alert">{message}</p>}
      <p className="text-sm text-muted-foreground">Below-reference work can be saved. This record does not claim a benefit or an activity score.</p>
      <button className={button} type="submit" disabled={paused || !availableNow || !configuration}>Save activity</button>
    </form>
    {configuration && <details><summary className="cursor-pointer">View the selected saved targets and references</summary>
      <PersonalConfigurationView version={{ configuration, referenceComparisons: [] }}/></details>}
  </section>;
}
function OwnedEntry({ ownerId, domainId }: { ownerId: string; domainId: string }) {
  const domainQuery = useQuery(personalDomainsQuery(ownerId, domainId));
  const availabilityQuery = useQuery(personalActivityEligibilityQuery(ownerId, domainId));
  const queries = useQueryClient();
  const [opening, setOpening] = useState<ActivityEntryMemory | null>(() => findActivityEntry(ownerId, domainId));
  const [refreshing, setRefreshing] = useState(false);
  const ownDomain = domainQuery.data && !Array.isArray(domainQuery.data) ? domainQuery.data : undefined;
  const availability = availabilityQuery.data;
  useEffect(() => {
    if (isActivityOwner(ownerId) && !opening && !refreshing && domainQuery.isSuccess && ownDomain && availabilityQuery.isSuccess && availability?.canCreate &&
      ownDomain.policyVersions.some(v => v.configuration.policyVersionId === availability.effectivePolicyVersionId))
      setOpening(retainActivityEntry(ownerId, ownDomain, availability.effectivePolicyVersionId));
  }, [opening, refreshing, ownerId, ownDomain, domainQuery.isSuccess, availability, availabilityQuery.isSuccess]);
  const reload = () => { void domainQuery.refetch(); void availabilityQuery.refetch(); };
  const restart = () => {
    if (!discardActivityEntry(ownerId, domainId)) return;
    setRefreshing(true); setOpening(null);
    void Promise.all([domainQuery.refetch(), availabilityQuery.refetch()]).finally(() => setRefreshing(false));
  };
  const saved = (activity: ActivityView) => {
    if (activity.ownerUserId !== ownerId || !isActivityOwner(ownerId)) return;
    queries.setQueryData(personalActivityQuery(ownerId, activity.activityId).queryKey, activity);
    void queries.invalidateQueries({ predicate: query => query.queryKey[0] === PERSONAL_ACTIVITIES_QUERY && query.queryKey[1] === ownerId });
  };
  if (opening) return <ActivityEntryForm key={`${ownerId}-${domainId}`} ownerId={ownerId} domain={opening.domain} entry={opening}
    effectivePolicyVersionId={opening.effectivePolicyVersionId} availableNow={domainQuery.isSuccess && availabilityQuery.isSuccess && availability?.canCreate === true &&
      availability.effectivePolicyVersionId === opening.effectivePolicyVersionId}
    reload={reload} restart={restart} onSaved={saved}/>;
  if (refreshing) return <p role="status">Refreshing your domain before starting a new draft…</p>;
  if (domainQuery.isError || availabilityQuery.isError) return <div className={panel} role="alert"><p>Domain availability could not be verified. No default policy or permission has been substituted.</p>
    <button className={button} onClick={reload}>Reload domain availability</button><Link href={`/domains/${encodeURIComponent(domainId)}`} className="underline block">Back to this domain</Link></div>;
  if (availability && !availability.canCreate) return <ActivityAvailability availability={availability} domainId={domainId}/>;
  return <p role="status">Loading your domain and saved activity availability…</p>;
}
export function ActivityHistory({ activities }: { activities: ActivityView[] }) {
  if (!activities.length) return <p className={panel}>No custom activities are saved in this page.</p>;
  return <ul className="space-y-3">{activities.map(activity => <li key={activity.activityId} className={panel}>
    <Link href={`/activities/${encodeURIComponent(activity.activityId)}`} className="underline font-semibold">{activity.configuration.displayName}</Link>
    <p>{activity.observedAt} · saved version {activity.configuration.revision}{activity.deletedAt ? " · deleted" : ""}</p>
    <ul>{Object.entries(activity.values).map(([id, value]) => { const m = activity.configuration.measurements.find(item => item.measurementId === id)!;
      return <li key={id}>{m.displayName}: {value.valueType === "boolean" ? value.value ? "Yes" : "No" : String(value.value)} {m.unit.customLabel ?? m.unit.unitId}</li>;
    })}</ul>
    {!Object.keys(activity.values).length && <p>Practice event · no invented duration or quantity</p>}
  </li>)}</ul>;
}
function OwnedHistory({ ownerId, domainId }: { ownerId: string; domainId?: string }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const query = useQuery(personalActivitiesQuery(ownerId, { domainId, ...(cursors.length ? { cursor: cursors[cursors.length - 1] } : {}), limit: 25 }));
  const nextCursor = query.data?.nextCursor;
  return <div className="space-y-4"><Link href="/domains" className="underline">Back to your domains</Link>
    <p className="text-sm text-muted-foreground">Your custom activity records use each event's saved configuration. Original sessions remain in the original history.</p>
    {query.isPending ? <p role="status">Loading your activity history…</p> : query.isError ? <div className={panel} role="alert"><p>Your activity history could not be verified.</p>
      <button className={button} onClick={() => { void query.refetch(); }}>Reload activity history</button></div> : query.data ? <>
        <ActivityHistory activities={query.data.activities}/><p>Showing {query.data.activities.length} records in this page.</p>
        {cursors.length > 0 && <button className={button} onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous page</button>}
        {nextCursor && <button className={button} onClick={() => setCursors(previous => [...previous, nextCursor])}>Next page</button>}
      </> : <p role="alert">No verified history response is available.</p>}
  </div>;
}
export function ActivityCorrectionForm({ ownerId, memory, availableNow, close, onSaved, initialTimezone }: {
  ownerId: string; memory: ActivityMutationMemory; availableNow: boolean; close: () => void; onSaved?: (activity: ActivityView) => void; initialTimezone?: string;
}) {
  const { base, domain, effectivePolicyVersionId, operation, session } = memory;
  const [snapshot, setSnapshot] = useState<ActivityMutationSnapshot>(() => session.getSnapshot());
  useEffect(() => session.subscribe(setSnapshot), [session]);
  const captured = session.getSnapshot().draft, initial = captured?.operation === "edit" ? captured.input : base;
  const [localZone] = useState(() => initialTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [timezone, setTimezone] = useState(localZone);
  const [when, setWhen] = useState(() => activityLocalTime(initial.observedAt, timezone) ?? "");
  const [key] = useState(() => captured?.input.mutationKey ?? crypto.randomUUID());
  const [reason, setReason] = useState(() => captured?.input.reason ?? "");
  const [fields, setFields] = useState<Record<string, ActivityField>>(() => Object.fromEntries(Object.entries(initial.values).map(([id, value]) =>
    [id, { unitId: value.unitId, valueType: value.valueType, ...(value.taskVariantId ? { taskVariantId: value.taskVariantId } : {}), raw: String(value.value) }])));
  const [notes, setNotes] = useState(() => initial.notes ?? ""), [context, setContext] = useState(() => initial.context?.description ?? "");
  const [message, setMessage] = useState("");
  const at = activityWallTime(when, timezone), configuration = domain && effectivePolicyVersionId && at ? activityConfiguration(domain, at, effectivePolicyVersionId) : null;
  const version = useRef(configuration?.policyVersionId), notified = useRef<string | null>(null);
  useEffect(() => { if (version.current !== configuration?.policyVersionId) {
    version.current = configuration?.policyVersionId; setFields({}); setMessage("The historical version changed. Enter its exact measurements again; no units were converted.");
  } }, [configuration?.policyVersionId]);
  const current = snapshot.ownerId === ownerId && snapshot.activityId === base.activityId ? snapshot : { ownerId, activityId: base.activityId, phase: "editing" as const };
  const paused = current.phase !== "editing", pending = current.phase === "saving" || current.phase === "checking";
  useEffect(() => { if (current.phase === "saved" && current.result && isActivityOwner(ownerId) && notified.current !== current.result.appliedStateFingerprint) {
    notified.current = current.result.appliedStateFingerprint; onSaved?.(current.result.activity);
  } }, [current, ownerId, onSaved]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); if (!availableNow || session.getSnapshot().phase !== "editing") return;
    try {
      const draft = operation === "edit" ? configuration && at ? { operation: "edit" as const,
        input: activityEditInput(base, configuration, key, reason, at, fields, notes, context) } : null : {
          operation, input: ActivityLifecycleInputSchema.parse({ mutationKey: key, expectedStateFingerprint: base.stateFingerprint, reason }) };
      if (!draft) throw 0; setMessage(""); void session.submit(draft);
    } catch { setMessage("Provide a reason and valid raw values under the exact historical version. Missing, zero and No remain different. Your domain cannot be changed here."); }
  };
  if (base.ownerUserId !== ownerId || snapshot.ownerId !== ownerId) return null;
  if (current.phase === "saved" && current.result) return <section className="space-y-4"><p role="status">Change acknowledged. Showing the current saved activity; later changes may also be present.</p>
    <ActivityRawView activity={current.result.activity}/><button type="button" className={button} onClick={close}>Return to saved activity</button></section>;
  return <section className="space-y-4" data-testid="activity-correction-form">
    <h2 className="text-xl font-semibold">{operation === "edit" ? "Correct this activity" : operation === "delete" ? "Delete this activity" : "Restore this activity"}</h2>
    <p>The activity stays in {base.configuration.displayName}. Changing domains requires a separate new event. Its submission identity and correction history are preserved.</p>
    {operation === "delete" && <p>Deletion keeps the saved record and its history. You can restore it later if this custom domain is active.</p>}
    {operation === "restore" && <p>Restoration keeps the original saved time, values and historical configuration.</p>}
    {paused && <p>Keep this tab open. The captured change, reason and key stay in memory across pages in this account; a reload does not preserve this private draft. Changing accounts clears it; check your own saved activity when you return before making another change.</p>}
    {current.phase === "uncertain" && <div role="alert" className={panel}><p>This change was not acknowledged or accepted. It may already be saved. Check this exact saved change before retrying; no newer state is substituted into your draft.</p>
      <button type="button" className={button} onClick={() => { void session.reconcile(); }}>Check saved change</button></div>}
    {current.phase === "retry_ready" && <div className={panel} role="status"><p>Your own saved change read found no change under this key. You may deliberately retry the same reason, values and expected state, or discard and reopen a fresh saved read.</p>
      <button type="button" className={button} disabled={!availableNow} onClick={() => { void session.retry(); }}>Retry this same change</button>
      <button type="button" className={`${button} ml-2`} onClick={close}>Discard change and reload</button></div>}
    {pending && <p role="status">{current.phase === "saving" ? "Saving your change…" : "Checking the saved change…"}</p>}
    {!availableNow && <p role="alert">Current activity access could not be verified for a new change. The captured draft remains here.</p>}
    <form onSubmit={submit} className={panel}><fieldset disabled={paused} className="space-y-4">
      {operation === "edit" && <><label className="block">Time zone for this entry<select className={input} value={timezone} onChange={event => {
        const zone = event.target.value; setWhen(at ? activityLocalTime(at, zone) ?? "" : ""); setTimezone(zone);
      }}><option value={localZone}>Local time · {localZone}</option>{localZone !== "UTC" && <option value="UTC">UTC</option>}</select></label>
        <label className="block">When did this happen? ({timezone})<input className={input} type="datetime-local" step="0.001" value={when}
        onChange={event => setWhen(event.target.value)} required/></label>
        <p>Enter an unambiguous event time in {timezone}, or choose UTC for a repeated daylight-saving hour. The exact saved policy at that time determines the fields and day boundary.</p>
        {configuration ? <><p>Selected saved version {configuration.revision} · day begins {String(configuration.boundary.dayStartHour).padStart(2, "0")}:00 in {configuration.boundary.timezone}</p>
          {configuration.measurements.filter(m => m.kind !== "frequency" && m.scope.kind === "per_event").map(m => <label key={m.measurementId} className="block">{m.displayName} · {m.unit.customLabel ?? m.unit.unitId}
            {m.taskVariantId ? ` · ${configuration.taskVariants.find(item => item.variantId === m.taskVariantId)?.displayName}` : ""}
            {m.valueType === "boolean" ? <select className={input} value={fields[m.measurementId]?.raw ?? ""} onChange={event => setFields(previous => ({ ...previous,
              [m.measurementId]: { unitId: m.unit.unitId, valueType: m.valueType, ...(m.taskVariantId ? { taskVariantId: m.taskVariantId } : {}), raw: event.target.value } }))}>
              <option value="">Not recorded</option><option value="true">Yes</option><option value="false">No</option></select> :
              <input className={input} type="number" min="0" step={m.valueType === "integer" ? "1" : "any"} value={fields[m.measurementId]?.raw ?? ""}
                onChange={event => setFields(previous => ({ ...previous, [m.measurementId]: { unitId: m.unit.unitId, valueType: m.valueType,
                  ...(m.taskVariantId ? { taskVariantId: m.taskVariantId } : {}), raw: event.target.value } }))}/>}<span className="text-sm text-muted-foreground">{m.meaning} · blank means not recorded</span></label>)}
          {configuration.measurements.every(m => m.kind === "frequency") && <p>This records the practice event alone; no per-event frequency total is invented.</p>}
        </> : <p role="alert">No eligible historical saved version covers this time. Scheduled configurations cannot be used.</p>}
        <label className="block">Notes (optional)<textarea className={input} maxLength={4000} value={notes} onChange={event => setNotes(event.target.value)}/></label>
        <label className="block">Practice context (optional)<textarea className={input} maxLength={2000} value={context} onChange={event => setContext(event.target.value)}/></label>
        {base.context?.taskConditions?.length ? <p>Existing declared task conditions stay with this correction.</p> : null}
      </>}
      <label className="block">Reason for this {operation === "edit" ? "correction" : operation === "delete" ? "deletion" : "restoration"}<textarea className={input}
        maxLength={500} value={reason} onChange={event => setReason(event.target.value)} required/></label>
    </fieldset>{message && <p role="alert">{message}</p>}<p className="text-sm text-muted-foreground">Below-reference raw work can be kept. No score or benefit is inferred from this correction.</p>
      <button className={button} type="submit" disabled={paused || !availableNow || (operation === "edit" && !configuration)}>
        {operation === "edit" ? "Save correction" : operation === "delete" ? "Confirm deletion" : "Confirm restoration"}</button>
      {current.phase === "editing" && <button className={`${button} ml-2`} type="button" onClick={close}>Cancel without changing activity</button>}
    </form><details><summary>View the original saved activity</summary><ActivityRawView activity={base}/></details>
    {operation === "edit" && configuration && <details><summary>View the selected historical targets and references</summary>
      <PersonalConfigurationView version={{ configuration, referenceComparisons: [] }}/></details>}
  </section>;
}
function OwnedActivityControls({ ownerId, activity, queryVerified, onSaved, onReload }: { ownerId: string; activity: ActivityView; queryVerified: boolean;
  onSaved: (activity: ActivityView) => void; onReload: () => void }) {
  const availabilityQuery = useQuery(personalActivityEligibilityQuery(ownerId, activity.domainId));
  const domainQuery = useQuery(personalDomainsQuery(ownerId, activity.domainId));
  const [opening, setOpening] = useState<ActivityMutationMemory | null>(() => findActivityMutation(ownerId, activity.activityId));
  const ownDomain = domainQuery.data && !Array.isArray(domainQuery.data) ? domainQuery.data : undefined, availability = availabilityQuery.data;
  const allowed = availabilityQuery.isSuccess && availability?.canCreate === true;
  const open = (operation: "edit" | "delete" | "restore") => {
    if (!queryVerified || !isActivityOwner(ownerId) || (operation !== "delete" && !allowed) || (operation === "edit" && !ownDomain)) return;
    setOpening(retainActivityMutation(ownerId, activity, ownDomain ?? null, availability?.canCreate ? availability.effectivePolicyVersionId : null, operation));
  };
  const close = () => { if (!discardActivityMutation(ownerId, activity.activityId)) return; setOpening(null); onReload(); };
  if (opening) return <ActivityCorrectionForm key={`${ownerId}-${activity.activityId}`} ownerId={ownerId} memory={opening}
    availableNow={queryVerified && (opening.operation === "delete" || (allowed && (opening.operation !== "edit" || availability?.canCreate === true &&
      opening.effectivePolicyVersionId === availability.effectivePolicyVersionId)))} close={close} onSaved={onSaved}/>;
  return <section className={`${panel} space-x-3`}>
    {activity.deletedAt === null ? <><button type="button" className={button} disabled={!queryVerified || !allowed || !domainQuery.isSuccess || !ownDomain} onClick={() => open("edit")}>Correct activity</button>
      <button type="button" className={button} disabled={!queryVerified} onClick={() => open("delete")}>Delete activity</button></> :
      <button type="button" className={button} disabled={!queryVerified || !allowed} onClick={() => open("restore")}>Restore activity</button>}
    {!allowed && <p>Corrections and restoration require an active custom domain. An inactive domain's existing manual record can still be deleted.</p>}
  </section>;
}
function OwnedActivity({ ownerId, activityId }: { ownerId: string; activityId: string }) {
  const query = useQuery(personalActivityQuery(ownerId, activityId)), queries = useQueryClient();
  const [, rerender] = useState(0);
  const retained = findActivityMutation(ownerId, activityId);
  const saved = (activity: ActivityView) => {
    if (!isActivityOwner(ownerId) || activity.ownerUserId !== ownerId || activity.activityId !== activityId) return;
    queries.setQueryData(personalActivityQuery(ownerId, activityId).queryKey, activity);
    void queries.invalidateQueries({ predicate: item => item.queryKey[0] === PERSONAL_ACTIVITIES_QUERY && item.queryKey[1] === ownerId });
  };
  const reload = () => { if (!isActivityOwner(ownerId)) return; rerender(value => value + 1); void query.refetch(); };
  // A failed refresh never hides a captured same-owner correction or replaces its expected state.
  if (retained) return <OwnedActivityControls ownerId={ownerId} activity={retained.base} queryVerified={query.isSuccess} onSaved={saved} onReload={reload}/>;
  return <div className="space-y-4"><Link href="/activities" className="underline">Back to your activity history</Link>
    {query.isPending ? <p role="status">Loading your saved activity…</p> : query.isError ? <div className={panel} role="alert"><p>This saved activity could not be verified for your account.</p>
      <button className={button} onClick={() => { void query.refetch(); }}>Reload saved activity</button></div> : query.data ? <><ActivityRawView activity={query.data}/>
        <OwnedActivityControls ownerId={ownerId} activity={query.data} queryVerified={query.isSuccess} onSaved={saved} onReload={reload}/></> : <p role="alert">No verified activity is available.</p>}
  </div>;
}
export default function ActivitiesPage() {
  const { user } = useAuth(); const [, entry] = useRoute("/activities/new/:domainId");
  const [, history] = useRoute("/activities/domain/:domainId"); const [, detail] = useRoute("/activities/:activityId");
  const ownerId = user?.id, domainId = entry?.domainId ?? history?.domainId, activityId = entry || history ? undefined : detail?.activityId;
  const valid = ownerId && ActivityIdSchema.safeParse(ownerId).success && (!domainId || ActivityIdSchema.safeParse(domainId).success) &&
    (!activityId || ActivityIdSchema.safeParse(activityId).success);
  const pendingEntries = valid && ownerId && !entry ? pendingActivityEntries(ownerId) : [];
  const pendingMutations = valid && ownerId && !entry ? pendingActivityMutations(ownerId) : [];
  return <div className="min-h-screen bg-background text-foreground px-6 py-8 pb-24"><header className="mb-6"><h1 className="text-2xl font-bold">{entry ? "Record activity" : detail && !history ? "Saved activity" : "Your activity history"}</h1></header>
    <main className="max-w-3xl space-y-4">{pendingEntries.map(pending => <p key={pending.domainId} role="status"><Link className="underline"
      href={`/activities/new/${encodeURIComponent(pending.domainId)}`}>Resolve the pending entry for {pending.displayName}</Link></p>)}
      {pendingMutations.map(pending => <p key={pending.activityId} role="status"><Link className="underline" href={`/activities/${encodeURIComponent(pending.activityId)}`}>
        Resolve the pending change for {pending.displayName}</Link></p>)}
      {!valid || !ownerId ? <p role="alert">Sign in with a valid owned activity path to continue.</p> : entry && domainId ?
      <OwnedEntry key={`${ownerId}-${domainId}`} ownerId={ownerId} domainId={domainId}/> : activityId ?
        <OwnedActivity key={`${ownerId}-${activityId}`} ownerId={ownerId} activityId={activityId}/> :
        <OwnedHistory key={`${ownerId}-${domainId ?? "all"}`} ownerId={ownerId} domainId={domainId}/>}</main>
  </div>;
}
