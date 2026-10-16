import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DomainConfiguration, QualificationPredicate } from "@shared/domain-config";
import type { ActivityEligibility } from "@shared/activity";
import { personalActivityEligibilityQuery } from "@/lib/activities-api";
import { useAuth } from "@/hooks/use-auth";
import DomainPolicyForm, { type DomainPolicyFormProps } from "@/components/domains/domain-policy-form";
import { describeCondition, DomainsApiError, PERSONAL_DOMAINS_QUERY, personalDomainBoundaryQuery, personalDomainsQuery,
  personalPolicySelection, type PersonalDomain, type PersonalPolicyVersion } from "@/lib/domains-api";

const intentLabels = { develop: "Develop a skill", maintain: "Maintain capability",
  general_wellbeing: "General wellbeing", unknown: "Not yet decided" };
const measurementLabels = { duration: "Duration", repetitions: "Repetitions", count: "Count",
  quantity: "Quantity or distance", completion: "Completion", frequency: "Practice frequency" };
const directionLabels = { higher_is_better: "Higher values preferred", lower_is_better: "Lower values preferred",
  within_range: "Within a range", equal: "An exact value" };
const aggregationLabels = { sum: "Adds amounts", mean: "Averages values", last: "Uses the most recent value",
  any: "Any completion", all: "All completions", count: "Counts qualifying practice" };
const panel = "rounded-2xl border border-border/60 bg-card p-5 space-y-3";
function dateLabel(value: string, timezone: string) {
  return `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value))} (${timezone})`;
}
function Conditions({ conditions, configuration }: {
  conditions: DomainConfiguration["targets"]["normal"]["conditions"]; configuration: DomainConfiguration;
}) {
  return <ul className="list-disc pl-5 space-y-1">{conditions.map((condition, index) =>
    <li key={index}>{describeCondition(condition, configuration)}</li>)}</ul>;
}
function Qualification({ predicate, configuration }: { predicate: QualificationPredicate; configuration: DomainConfiguration }) {
  if (predicate.kind === "condition") return <p>{describeCondition(predicate.condition, configuration)}</p>;
  return <div><p>{predicate.kind === "all" ? "All of these conditions" : "Any of these conditions"}</p>
    <ul className="list-disc pl-5 space-y-1">{predicate.predicates.map((child, index) =>
      <li key={index}><Qualification predicate={child} configuration={configuration} /></li>)}</ul></div>;
}
function Source({ url }: { url: string }) {
  return /^https?:\/\//i.test(url) ? <a href={url} target="_blank" rel="noreferrer" className="underline break-all">View source</a> :
    <span className="break-all">Source address: {url}</span>;
}
/** Read-only presentation preserves all declared measurements and saved configuration. */
export function PersonalConfigurationView({ version }: { version: PersonalPolicyVersion }) {
  const c = version.configuration;
  return <div className="space-y-5 text-sm">
    <section className={panel}>
      <h3 className="text-lg font-semibold">Goal and review</h3>
      <p><strong>Intent:</strong> {intentLabels[c.goal.intent]}</p>
      <p><strong>Desired capability:</strong> {c.goal.desiredCapability}</p>
      {c.goal.currentCapability && <p><strong>Current assessment:</strong> {c.goal.currentCapability.assessment}
        {" — "}{dateLabel(c.goal.currentCapability.assessedAt, c.boundary.timezone)}</p>}
      {c.goal.privateMotivation && <details><summary className="cursor-pointer">Your private motivation</summary>
        <p className="mt-2 whitespace-pre-wrap break-words">{c.goal.privateMotivation}</p></details>}
      {c.goal.taskConditions?.length ? <ul className="list-disc pl-5">{c.goal.taskConditions.map(condition =>
        <li key={condition.conditionId}>{condition.description}</li>)}</ul> : null}
      <p><strong>Day begins:</strong> {`${String(c.boundary.dayStartHour).padStart(2, "0")}:00`} in {c.boundary.timezone}</p>
      <p><strong>Review cadence:</strong> every {c.review.intervalDays} days, anchored {dateLabel(c.review.anchorAt, c.boundary.timezone)}</p>
      {c.review.lastReviewedAt && <p>Last reviewed: {dateLabel(c.review.lastReviewedAt, c.boundary.timezone)}</p>}
      {c.review.nextReviewAt && <p>Next planned review: {dateLabel(c.review.nextReviewAt, c.boundary.timezone)}</p>}
      <p className="text-muted-foreground">A review date does not change your target automatically.</p>
    </section>
    <section className={panel}>
      <h3 className="text-lg font-semibold">What you measure</h3>
      {c.measurements.map(measurement => <div key={measurement.measurementId} className="border-t border-border/50 pt-3 first:border-0 first:pt-0">
        <h4 className="font-semibold">{measurement.displayName}</h4>
        <p>{measurement.meaning}</p>
        <p>{measurementLabels[measurement.kind]} · {measurement.unit.customLabel ?? measurement.unit.unitId}
          {" · "}{measurement.scope.kind === "per_event" ? "per practice event" : `over ${measurement.scope.windowDays} days`}</p>
        {measurement.kind === "frequency" && <p>Counts {measurement.countBy === "distinct_days" ? "distinct practice days" : "practice events"}.</p>}
        <p className="text-muted-foreground">{measurement.role === "practice" ? "Practice measure" : measurement.role === "outcome" ? "Outcome measure" : "Context measure"}
          {" · "}{directionLabels[measurement.comparisonDirection]} · {aggregationLabels[measurement.aggregation]}</p>
        {measurement.taskVariantId && <p>Applies to: {c.taskVariants.find(variant => variant.variantId === measurement.taskVariantId)?.displayName}</p>}
      </div>)}
      {c.taskVariants.map(variant => <div key={variant.variantId}><h4 className="font-semibold">{variant.displayName}</h4>
        <ul className="list-disc pl-5">{variant.taskConditions.map(condition => <li key={condition.conditionId}>{condition.description}</li>)}</ul></div>)}
    </section>
    <section className={panel}>
      <h3 className="text-lg font-semibold">Your targets</h3>
      <h4 className="font-semibold">Normal target{c.targets.normal.displayName ? ` — ${c.targets.normal.displayName}` : ""}</h4>
      <Conditions conditions={c.targets.normal.conditions} configuration={c} />
      {c.targets.stretch && <div><h4 className="font-semibold">Stretch target{c.targets.stretch.displayName ? ` — ${c.targets.stretch.displayName}` : ""}</h4>
        <Conditions conditions={c.targets.stretch.conditions} configuration={c} /></div>}
      {c.targets.adapted && <div><h4 className="font-semibold">Adapted target{c.targets.adapted.target.displayName ? ` — ${c.targets.adapted.target.displayName}` : ""}</h4>
        <Conditions conditions={c.targets.adapted.target.conditions} configuration={c} />
        <p>{c.targets.adapted.duration === "temporary" ? "Temporary" : "Ongoing"} adaptation from {dateLabel(c.targets.adapted.effectiveFrom, c.boundary.timezone)}.</p>
        {c.targets.adapted.reviewAt && <p>Adaptation review: {dateLabel(c.targets.adapted.reviewAt, c.boundary.timezone)}</p>}
        {c.targets.adapted.reason && <p>Reason: {c.targets.adapted.reason}</p>}
        <p className="text-muted-foreground">Review does not automatically end the adaptation or increase your target.</p></div>}
      {c.targets.upperRecovery && <div><h4 className="font-semibold">Upper recovery guidance</h4>
        <Conditions conditions={c.targets.upperRecovery.conditions} configuration={c} />
        {c.targets.upperRecovery.guidance && <p>{c.targets.upperRecovery.guidance}</p>}</div>}
      {c.qualification && <div><h4 className="font-semibold">Qualifying practice</h4><Qualification predicate={c.qualification} configuration={c} /></div>}
    </section>
    <section className={panel}>
      <h3 className="text-lg font-semibold">Reference benchmarks</h3>
      {c.references.length === 0 && <p>No reference benchmark has been declared. No minimum has been inferred.</p>}
      {c.references.map(reference => <div key={reference.referenceId} className="border-t border-border/50 pt-3 first:border-0 first:pt-0">
        <h4 className="font-semibold">{intentLabels[reference.purpose]} reference</h4>
        <p>{reference.applicability.description}</p>
        {reference.status === "known" ? <Conditions conditions={reference.conditions} configuration={c} /> :
          <p>{reference.status === "unknown" ? "Reference unknown; no minimum inferred." : "Reference not applicable."}{reference.note ? ` ${reference.note}` : ""}</p>}
        <p>Evidence: {reference.evidence.category} · confidence {reference.evidence.confidence} ·
          {reference.evidence.review.status === "reviewed" ? ` reviewed ${dateLabel(reference.evidence.review.reviewedAt, c.boundary.timezone)}` : " not yet reviewed"}</p>
        {reference.evidence.source && <p>{reference.evidence.source.description}{reference.evidence.source.url && <>{" · "}<Source url={reference.evidence.source.url} /></>}</p>}
        {reference.applicability.taskConditions?.map(condition => <p key={condition.conditionId}>{condition.description}</p>)}
        {version.referenceComparisons.filter(item => item.referenceId === reference.referenceId).map(item =>
          <p key={`${item.targetKind}-${item.targetId}`} data-testid={`reference-${item.status}`} className="rounded-lg border border-border/60 p-3">
            <strong>{item.targetKind === "normal" ? "Normal" : "Adapted"} target:</strong> {item.message}
            {item.active ? " Selected within this saved configuration." : " Not selected within this saved configuration."}</p>)}
      </div>)}
      <p className="text-muted-foreground">These notices compare saved targets with their stated references. They are not activity scores or a guarantee of benefit.</p>
    </section>
  </div>;
}
export function PersonalDomainsList({ domains, navigationPaused = false }: { domains: PersonalDomain[]; navigationPaused?: boolean }) {
  if (navigationPaused) return <p className={panel}>Finish or discard this draft before selecting another domain.</p>;
  if (!domains.length) return <p className={panel} data-testid="domains-empty">You have no personal domains yet.</p>;
  return <ul className="space-y-3" data-testid="personal-domains-list">{domains.map(domain => {
    const selected = personalPolicySelection(domain);
    return <li key={domain.domainId}><Link href={`/domains/${encodeURIComponent(domain.domainId)}`} className={`${panel} block hover:bg-muted/40`}>
      <h2 className="text-lg font-semibold">{domain.displayName}</h2>
      <p>{selected.current ? intentLabels[selected.current.configuration.goal.intent] : selected.latest ? "No active configuration yet" : "No configuration yet"}</p>
      {selected.scheduled.length > 0 && <p>{selected.scheduled.length} scheduled configuration{selected.scheduled.length === 1 ? "" : "s"}</p>}
      <p className="text-muted-foreground">Score not calculated</p>
    </Link></li>;
  })}</ul>;
}
export function PersonalDomainActivityLinks({ domainId, availability, loading, error, retry }: {
  domainId: string; availability?: ActivityEligibility; loading?: boolean; error?: boolean; retry?: () => void;
}) {
  const verified = availability?.domainId === domainId ? availability : undefined;
  return <section className={panel} data-testid="domain-activity-links">
    <Link href={`/activities/domain/${encodeURIComponent(domainId)}`} className="underline">View this domain's custom activity history</Link>
    {loading ? <p role="status">Checking activity availability…</p> : error || !verified ? <><p role="alert">Activity availability could not be verified.</p>
      {retry && <button type="button" className="underline" onClick={retry}>Check activity availability</button>}</> : verified.canCreate ?
        <Link href={`/activities/new/${encodeURIComponent(domainId)}`} className="underline block">Record activity</Link> :
        <><p>{verified.reason === "legacy_writer" ? "This domain uses the original session logger." : verified.reason === "inactive" ?
          "This domain is inactive; new activity is unavailable." : "Its first configuration has not taken effect; scheduled activity entry is unavailable."}</p>
          {verified.reason === "legacy_writer" && <Link href="/log" className="underline">Open the original logger</Link>}</>}
  </section>;
}
function OwnedDomainActivityLinks({ ownerId, domainId }: { ownerId: string; domainId: string }) {
  const query = useQuery(personalActivityEligibilityQuery(ownerId, domainId));
  return <PersonalDomainActivityLinks domainId={domainId} availability={query.data} loading={query.isPending} error={query.isError}
    retry={() => { void query.refetch(); }}/>
}
export function PersonalDomainDetail({ domain, activityOwnerId }: { domain: PersonalDomain; activityOwnerId?: string }) {
  const selected = personalPolicySelection(domain);
  return <div className="space-y-5" data-testid="personal-domain-detail">
    <h2 className="text-2xl font-bold break-words">{domain.displayName}</h2>
    <p className="text-muted-foreground" data-testid="domain-score-unavailable">Score not calculated. These are your saved targets and references.</p>
    {activityOwnerId && <OwnedDomainActivityLinks key={`${activityOwnerId}-${domain.domainId}`} ownerId={activityOwnerId} domainId={domain.domainId}/>}
    {selected.current ? <section className="space-y-4"><h3 className="text-xl font-semibold">Active configuration</h3>
      <p>Version {selected.current.configuration.revision} · effective {dateLabel(selected.current.configuration.effectiveFrom, selected.current.configuration.boundary.timezone)}</p>
      <PersonalConfigurationView version={selected.current} /></section> :
      selected.latest ? <p className={panel} data-testid="domain-no-active-policy">No active configuration yet. The scheduled configuration below has not taken effect.</p> :
        <p className={panel} data-testid="domain-no-configuration">No configuration yet. This domain has no saved goals or measurements.</p>}
    {selected.scheduled.map(version => <details key={version.configuration.policyVersionId} className={panel} open={!selected.current}>
      <summary className="cursor-pointer font-semibold">Scheduled version {version.configuration.revision} · starts {dateLabel(version.configuration.effectiveFrom, version.configuration.boundary.timezone)}</summary>
      <PersonalConfigurationView version={version} /></details>)}
    {selected.current && domain.policyVersions.filter(version => version.configuration.revision < selected.current!.configuration.revision).map(version =>
      <details key={version.configuration.policyVersionId} className={panel}><summary className="cursor-pointer font-semibold">Earlier version {version.configuration.revision} · from {dateLabel(version.configuration.effectiveFrom, version.configuration.boundary.timezone)}</summary>
        <PersonalConfigurationView version={version} /></details>)}
  </div>;
}
export function PersonalDomainsNotice({ loading, error, retry }: { loading?: boolean; error?: unknown; retry?: () => void }) {
  if (loading) return <p className={panel} role="status" data-testid="domains-loading">Loading your domains…</p>;
  const message = error instanceof DomainsApiError ? error.message : "Your domains could not be loaded. Please try again.";
  return <div className={panel} role="alert" data-testid="domains-error"><p>{message}</p>
    {retry && <button type="button" onClick={retry} className="underline font-semibold">Try again</button>}</div>;
}
export function PersonalDomainActions({ domain, onAdd, onConfigure }: { domain?: PersonalDomain; onAdd: () => void; onConfigure: () => void }) {
  const latest = domain ? personalPolicySelection(domain).latest : undefined;
  if (domain && !latest) return <p className={panel}>Configuration setup is not available for a domain with no saved policy yet.</p>;
  return <div className="space-y-2"><button type="button" className="rounded-lg border border-border px-4 py-2 text-sm font-semibold"
    onClick={domain ? onConfigure : onAdd}>{domain ? "Schedule a new configuration" : "Add domain"}</button>
    {domain && <p className="text-sm text-muted-foreground">Starts from latest saved version {latest!.configuration.revision}, including any scheduled changes.</p>}</div>;
}
export function PersonalDomainsBackLink({ domainId, editing }: { domainId?: string; editing: boolean }) {
  return editing ? <p className="text-sm text-muted-foreground">Your domains · finish this draft to return</p> :
    <Link href={domainId ? "/domains" : "/settings"} className="underline text-sm">{domainId ? "Back to your domains" : "Back to settings"}</Link>;
}
export type PersonalDomainDraftSession = { ownerId: string; kind: "new"; domainId?: undefined } |
  { ownerId: string; kind: "configure"; domainId: string; openingConfiguration: DomainConfiguration };
export function openPersonalDomainDraft(ownerId: string, domain?: PersonalDomain): PersonalDomainDraftSession {
  if (!ownerId) throw new DomainsApiError(401);
  if (!domain) return { ownerId, kind: "new" };
  const latest = personalPolicySelection(domain).latest?.configuration;
  if (!latest || latest.ownerUserId !== ownerId || latest.domainId !== domain.domainId) throw new DomainsApiError(404);
  return { ownerId, kind: "configure", domainId: domain.domainId, openingConfiguration: structuredClone(latest) };
}
export function NewDomainForm({ ownerId, onSaved, onCancel, onReconcile }: Omit<DomainPolicyFormProps, "boundary" | "domainId" | "previous" | "latestPolicyVersionId">) {
  const query = useQuery(personalDomainBoundaryQuery(ownerId));
  const [verified, setVerified] = useState<{ ownerId: string; boundary: DomainPolicyFormProps["boundary"] } | null>(() =>
    query.isSuccess && query.data ? { ownerId, boundary: structuredClone(query.data) } : null);
  useEffect(() => {
    if (query.isSuccess && query.data) {
      const boundary = structuredClone(query.data);
      setVerified(current => current?.ownerId === ownerId ? current : { ownerId, boundary });
    }
  }, [ownerId, query.isSuccess, query.data]);
  // The first owner-verified boundary belongs to this draft, independently of later query state.
  if (verified?.ownerId === ownerId) return <>
    {query.isError && <div role="alert" className={panel}><p>Day settings could not be refreshed. This draft keeps the day settings verified when it opened.</p>
      <button type="button" className="underline" onClick={() => { void query.refetch(); }}>Reload day settings</button></div>}
    <DomainPolicyForm ownerId={ownerId} boundary={verified.boundary} onSaved={onSaved} onCancel={onCancel} onReconcile={onReconcile} />
  </>;
  if (query.isPending) return <p role="status" className={panel}>Loading your day settings before creating a domain…</p>;
  if (query.isError || !query.data) return <div role="alert" className={panel}><p>Your day settings could not be verified. No default boundary has been substituted.</p>
    <button type="button" className="underline" onClick={() => { void query.refetch(); }}>Reload day settings</button>
    <button type="button" className="underline ml-4" onClick={onCancel}>Cancel</button></div>;
  return <p role="status" className={panel}>Preparing your verified day settings…</p>;
}
export function PersonalDomainDraftSlot({ session, ownerId, domainId, latestPolicyVersionId, onSaved, onCancel, onReconcile }: {
  session: PersonalDomainDraftSession | null; ownerId?: string; domainId?: string; latestPolicyVersionId?: string | null;
} & Pick<DomainPolicyFormProps, "onSaved" | "onCancel" | "onReconcile">) {
  if (!session || !ownerId || session.ownerId !== ownerId || session.domainId !== domainId) return null;
  return session.kind === "new" ? <NewDomainForm key={`${ownerId}-new`} ownerId={ownerId} onSaved={onSaved} onCancel={onCancel} onReconcile={onReconcile} /> :
    <DomainPolicyForm key={`${ownerId}-${session.domainId}`} ownerId={ownerId} boundary={session.openingConfiguration.boundary}
      previous={session.openingConfiguration} domainId={session.domainId} latestPolicyVersionId={latestPolicyVersionId}
      onSaved={onSaved} onCancel={onCancel} onReconcile={onReconcile} />;
}
export default function DomainSettingsPage() {
  const { user } = useAuth();
  const [, params] = useRoute("/domains/:domainId");
  const domainId = params?.domainId;
  const queryClient = useQueryClient();
  const ownerId = user?.id;
  const ownerRef = useRef(ownerId); ownerRef.current = ownerId;
  const [, navigate] = useLocation();
  const [form, setForm] = useState<PersonalDomainDraftSession | null>(null);
  useEffect(() => {
    queryClient.removeQueries({ predicate: query => query.queryKey[0] === PERSONAL_DOMAINS_QUERY && query.queryKey[1] !== ownerId });
    setForm(null);
  }, [ownerId, domainId, queryClient]);
  let options: ReturnType<typeof personalDomainsQuery> | undefined;
  let inputError: unknown;
  try { if (ownerId) options = personalDomainsQuery(ownerId, domainId); } catch (error) { inputError = error; }
  const query = useQuery({ ...(options ?? { queryKey: [PERSONAL_DOMAINS_QUERY, "unavailable", "list", null] as const,
    queryFn: async () => { throw new DomainsApiError(401); }, staleTime: 0, gcTime: 0, retry: false as const }),
    enabled: !!options });
  const domain = query.data && !Array.isArray(query.data) ? query.data : undefined;
  const activeForm = form && ownerId && form.ownerId === ownerId && form.domainId === domainId ? form : null;
  const saved = (value: PersonalDomain) => {
    if (!ownerId || ownerRef.current !== ownerId) return;
    queryClient.setQueryData(personalDomainsQuery(ownerId, value.domainId).queryKey, value);
    void queryClient.invalidateQueries({ predicate: item => item.queryKey[0] === PERSONAL_DOMAINS_QUERY && item.queryKey[1] === ownerId });
    setForm(null); navigate(`/domains/${encodeURIComponent(value.domainId)}`);
  };
  const reconcile: DomainPolicyFormProps["onReconcile"] = async (slug, signal) => {
    if (!ownerId || ownerRef.current !== ownerId) throw new DomainsApiError(401);
    const data = await personalDomainsQuery(ownerId, domainId).queryFn({ signal });
    if (signal.aborted || ownerRef.current !== ownerId) throw new DomainsApiError(401);
    queryClient.setQueryData(personalDomainsQuery(ownerId, domainId).queryKey, data);
    return Array.isArray(data) ? data.find(item => item.slug === slug) ?? null : data;
  };
  const latest = domain ? personalPolicySelection(domain).latest?.configuration : undefined;
  return <div className="min-h-screen bg-background text-foreground pb-24 font-sans">
    <header className="px-6 py-8 space-y-2"><PersonalDomainsBackLink domainId={domainId} editing={!!activeForm} />
      <h1 className="text-2xl font-bold">Your domains</h1>
      <p className="text-sm text-muted-foreground">Your saved goals, measurements and reference benchmarks.</p>
      {ownerId && !activeForm && <Link href="/activities" className="underline">Your custom activity history</Link>}</header>
    <main className="px-6 max-w-3xl space-y-5">
      {ownerId && query.isSuccess && !activeForm && <PersonalDomainActions domain={domainId ? domain : undefined}
        onAdd={() => setForm(openPersonalDomainDraft(ownerId))}
        onConfigure={() => { if (domain) setForm(openPersonalDomainDraft(ownerId, domain)); }} />}
      <PersonalDomainDraftSlot session={activeForm} ownerId={ownerId} domainId={domainId}
        latestPolicyVersionId={query.isSuccess ? latest?.policyVersionId ?? null : undefined}
        onSaved={saved} onCancel={() => setForm(null)} onReconcile={reconcile} />
      {inputError || !ownerId ? <PersonalDomainsNotice error={inputError ?? new DomainsApiError(401)} /> :
        query.isPending ? <PersonalDomainsNotice loading /> : query.isError ? <PersonalDomainsNotice error={query.error} retry={() => { void query.refetch(); }} /> :
          domainId && query.data && !Array.isArray(query.data) ? <PersonalDomainDetail domain={query.data} activityOwnerId={activeForm ? undefined : ownerId} /> :
            !domainId && Array.isArray(query.data) ? <PersonalDomainsList domains={query.data} navigationPaused={!!activeForm} /> : <PersonalDomainsNotice error={new DomainsApiError(503)} />}
    </main>
  </div>;
}
