import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import type { OnboardingReady, OnboardingSettings } from "@shared/onboarding";
import DomainPolicyForm from "@/components/domains/domain-policy-form";
import { DomainsApiError, personalDomainsQuery, PERSONAL_DOMAINS_QUERY, type PersonalDomain } from "@/lib/domains-api";
import { OnboardingApiError, onboardingStatusQuery, savePersonalDaySettings, type PersonalDaySettingsPatch } from "@/lib/onboarding-api";

const panel = "rounded-2xl border border-border/60 bg-card p-5 space-y-4 min-w-0";
const input = "w-full min-w-0 rounded-lg border border-border bg-background p-2 text-sm";
const button = "rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-50";
export type PersonalDayDraft = Pick<OnboardingSettings, "dayStartHour" | "timezone" | "windowDays">;
export const FIRST_DAY_CHOICES: PersonalDayDraft = { dayStartHour: 4, timezone: "America/New_York", windowDays: 7 };
export function personalDayIssues(value: PersonalDayDraft, saved: OnboardingSettings | null): string[] {
  const issues: string[] = [];
  if (!Number.isInteger(value.dayStartHour) || value.dayStartHour < 0 || value.dayStartHour > 23) issues.push("Choose a valid day-start hour.");
  try {
    if (!value.timezone || value.timezone.length > 64) throw 0;
    new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  } catch { issues.push("Choose a valid timezone."); }
  if (!Number.isSafeInteger(value.windowDays) || value.windowDays < 1 ||
    value.windowDays !== saved?.windowDays && ![7, 14, 28, 42].includes(value.windowDays)) issues.push("Choose an available tracking window.");
  return issues;
}
export function personalDayPatch(value: PersonalDayDraft, saved: OnboardingSettings | null): PersonalDaySettingsPatch | null {
  const patch: PersonalDaySettingsPatch = {};
  if (!saved || value.dayStartHour !== saved.dayStartHour) patch.dayStartHour = value.dayStartHour;
  if (!saved || value.timezone !== saved.timezone) patch.timezone = value.timezone;
  if (!saved || value.windowDays !== saved.windowDays) {
    if (value.windowDays !== 7 && value.windowDays !== 14 && value.windowDays !== 28 && value.windowDays !== 42)
      throw new OnboardingApiError(400);
    patch.windowDays = value.windowDays;
  }
  return Object.keys(patch).length ? patch : null;
}
export function PersonalDayEditor({ value, saved, disabled, onChange }: { value: PersonalDayDraft;
  saved: OnboardingSettings | null; disabled: boolean; onChange: (value: PersonalDayDraft) => void }) {
  const validHour = Number.isInteger(value.dayStartHour) && value.dayStartHour >= 0 && value.dayStartHour <= 23;
  const validWindow = Number.isSafeInteger(value.windowDays) && value.windowDays > 0;
  const hours = Array.from(new Set([...Array.from({ length: 7 }, (_, n) => n), ...(validHour ? [value.dayStartHour] : [])])).sort((a, b) => a - b);
  const windows = Array.from(new Set([7, 14, 28, 42, ...(validWindow ? [value.windowDays] : [])])).sort((a, b) => a - b);
  return <fieldset className="space-y-3" disabled={disabled}>
    <p>{saved ? "These are your saved day settings. Keeping them does not change your account." :
      "These are suggested defaults, not verified saved settings. Save your choice before adding a domain."}</p>
    <label className="block space-y-1"><span className="font-semibold">Day starts at</span><select className={input} value={validHour ? value.dayStartHour : ""}
      onChange={event => onChange({ ...value, dayStartHour: Number(event.target.value) })}>
      {!validHour && <option value="">Choose a day-start hour</option>}
      {hours.map(hour => <option key={hour} value={hour}>{hour === 0 ? "12 a.m." : hour < 12 ? `${hour} a.m.` : hour === 12 ? "12 p.m." : `${hour - 12} p.m.`}
        {hour > 6 ? " (saved value)" : ""}</option>)}</select></label>
    <label className="block space-y-1"><span className="font-semibold">Timezone</span><input className={input} value={value.timezone} maxLength={64}
      onChange={event => onChange({ ...value, timezone: event.target.value })} required /></label>
    <p className="text-sm">Use a timezone such as America/New_York or Europe/London. Your browser timezone is not substituted automatically.</p>
    <label className="block space-y-1"><span className="font-semibold">Tracking window</span><select className={input} value={validWindow ? value.windowDays : ""}
      onChange={event => onChange({ ...value, windowDays: Number(event.target.value) })}>
      {!validWindow && <option value="">Choose a tracking window</option>}
      {windows.map(days => <option key={days} value={days}>{days} days{![7, 14, 28, 42].includes(days) ? " (saved value)" : ""}</option>)}</select></label>
    <p className="text-sm">A saved policy keeps its own measurement periods and day boundary. Changing these settings does not rewrite an existing configuration.</p>
  </fieldset>;
}
export function PersonalJourneyIntro({ settingsOnly }: { settingsOnly: boolean }) {
  return <><h1 className="text-2xl font-bold">{settingsOnly ? "Your day settings" : "Make this yours"}</h1>
    <p>{settingsOnly ? "Your saved day boundary and tracking window." :
      "Choose your own domain, what you measure and a target that suits your goal."}</p>
    {!settingsOnly && <p className="text-sm">Your intent can stay undecided, your desired capability can be defined later, and motivation is private and optional.
      No practice minimum is assumed. The initial review cadence is every 84 days.</p>}</>;
}
type Props = { ownerId: string; status: OnboardingReady; settingsOnly?: boolean; onOwnedStatusChanged?: () => void };
export default function OnboardingPage({ ownerId, status, settingsOnly = false, onOwnedStatusChanged }: Props) {
  // This render gate also hides an old owner's fields before effect cleanup.
  if (status.ownerUserId !== ownerId || status.settings && status.settings.userId !== ownerId)
    return <p role="alert">Your own workspace and day settings must be verified before continuing.</p>;
  return <OwnedPersonalJourney key={`${ownerId}-${settingsOnly ? "settings" : "first"}`} ownerId={ownerId} status={status} settingsOnly={settingsOnly} onOwnedStatusChanged={onOwnedStatusChanged} />;
}
function OwnedPersonalJourney({ ownerId, status, settingsOnly, onOwnedStatusChanged }: Props) {
  const [verified, setVerified] = useState<OnboardingSettings | null>(status.settings);
  const [day, setDay] = useState<PersonalDayDraft>(status.settings ?? { ...FIRST_DAY_CHOICES });
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const lifetime = useRef({ ownerId, alive: true, pending: false, generation: 0, controller: undefined as AbortController | undefined });
  const [, navigate] = useLocation();
  const queries = useQueryClient();
  const dayIssues = personalDayIssues(day, verified);
  const dayChange = dayIssues.length ? null : personalDayPatch(day, verified);
  useEffect(() => {
    const life = lifetime.current; life.alive = true;
    return () => { life.alive = false; life.generation++; life.controller?.abort(); };
  }, [ownerId]);
  const current = (generation: number) => lifetime.current.alive && lifetime.current.ownerId === ownerId && lifetime.current.generation === generation;
  const begin = () => {
    const life = lifetime.current;
    if (!life.alive || life.pending || editing) return null;
    life.pending = true; life.controller = new AbortController(); setPending(true);
    return { generation: ++life.generation, signal: life.controller.signal };
  };
  const end = (generation: number) => { if (current(generation)) { lifetime.current.pending = false; setPending(false); } };
  const saveDay = async (event: React.FormEvent) => {
    event.preventDefault(); if (uncertain) return;
    if (dayIssues.length) { setMessage(dayIssues.join(" ")); return; }
    const patch = dayChange;
    if (!patch) { setMessage("Your saved day settings already match this choice."); return; }
    const operation = begin(); if (!operation) return; setMessage("");
    try {
      const saved = await savePersonalDaySettings(ownerId, patch, operation.signal);
      if (current(operation.generation)) {
        setVerified(saved); setDay(saved); setMessage("Your day settings are saved.");
        onOwnedStatusChanged?.(); // Refresh the saved projection; do not infer completion.
      }
    } catch (error) {
      if (current(operation.generation)) {
        const failure = error instanceof OnboardingApiError ? error : new OnboardingApiError(503, true);
        setUncertain(failure.needsReconciliation); setMessage(failure.needsReconciliation ?
          "The day-settings save outcome is uncertain. Refresh your saved settings before trying again or opening a domain draft." : failure.message);
      }
    } finally { end(operation.generation); }
  };
  const refreshDay = async () => {
    const operation = begin(); if (!operation) return;
    try {
      const saved = await onboardingStatusQuery(ownerId).queryFn({ signal: operation.signal });
      if (saved.status !== "ready" || saved.settings === null) throw new OnboardingApiError(503);
      if (current(operation.generation)) { setVerified(saved.settings); setDay(saved.settings); setUncertain(false);
        setMessage("Your saved day settings were verified. Review them before continuing.");
        onOwnedStatusChanged?.(); }
    } catch { if (current(operation.generation)) setMessage("Your saved settings could not be refreshed. The last verified boundary is retained; an uncertain save stays paused."); }
    finally { end(operation.generation); }
  };
  const savedDomain = (domain: PersonalDomain) => {
    if (!lifetime.current.alive || lifetime.current.ownerId !== ownerId) return;
    queries.setQueryData(personalDomainsQuery(ownerId, domain.domainId).queryKey, domain);
    void queries.invalidateQueries({ predicate: query => query.queryKey[0] === PERSONAL_DOMAINS_QUERY && query.queryKey[1] === ownerId });
    setEditing(false); navigate(`/domains/${encodeURIComponent(domain.domainId)}`);
    onOwnedStatusChanged?.(); // Refresh the actual owned status, including a future first policy.
  };
  const reconcileDomain = async (slug: string | undefined, signal: AbortSignal) => {
    const data = await personalDomainsQuery(ownerId).queryFn({ signal });
    if (signal.aborted || !lifetime.current.alive || lifetime.current.ownerId !== ownerId) throw new DomainsApiError(401);
    if (!Array.isArray(data)) throw new DomainsApiError(503);
    queries.setQueryData(personalDomainsQuery(ownerId).queryKey, data);
    return data.find(domain => domain.slug === slug) ?? null;
  };
  return <div className="min-h-screen bg-background text-foreground pb-20 font-sans">
    <header className="px-6 py-8 space-y-3 max-w-3xl"><PersonalJourneyIntro settingsOnly={!!settingsOnly} /></header>
    <main className="px-6 max-w-3xl space-y-5">
      {editing && verified ? <DomainPolicyForm ownerId={ownerId} boundary={{ timezone: verified.timezone, dayStartHour: verified.dayStartHour }}
        onSaved={savedDomain} onCancel={() => setEditing(false)} onReconcile={reconcileDomain} /> : <>
        <form className={panel} onSubmit={event => { void saveDay(event); }}><h2 className="text-lg font-semibold">Your day boundary</h2>
          <PersonalDayEditor value={day} saved={verified} disabled={pending || uncertain} onChange={setDay} />
          {dayIssues.length > 0 && <p role="alert">{dayIssues.join(" ")}</p>}
          {message && <p role="status">{message}</p>}
          <div className="flex flex-wrap gap-3"><button className={button} type="submit" disabled={pending || uncertain}>{pending ? "Checking…" : "Save day settings"}</button>
            <button className={button} type="button" disabled={pending} onClick={() => { void refreshDay(); }}>Refresh saved day settings</button></div>
        </form>
        {!settingsOnly && <section className={panel}><h2 className="text-lg font-semibold">Your first personal domain</h2>
          <p>Measure time, repetitions, quantity, completion or practice frequency. A future configuration stays scheduled until it starts.</p>
          <button type="button" className={button} disabled={!verified || pending || uncertain || dayIssues.length > 0 || !!dayChange}
            onClick={() => setEditing(true)}>Define my first domain</button>
          {!verified && <p>Save and verify your own day settings first.</p>}
          {verified && dayChange && <p>Save your changed day settings or refresh the saved choice before opening the form.</p>}
          <p className="text-sm">You can log activity for your personal domain. Qualification and scores are not calculated yet.</p></section>}
        {!pending && !uncertain && <nav className="flex gap-4 text-sm"><Link href="/domains" className="underline">Your domains</Link>
          {!settingsOnly && <Link href="/settings" className="underline">Your day settings</Link>}</nav>}
      </>}
    </main>
  </div>;
}
