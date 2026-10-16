import React, { useEffect, useRef, useState } from "react";
import type { DomainConfiguration, MeasurementDefinition, TypedCondition } from "@shared/domain-config";
import { conditionFor, domainSlug, draftIdentities, editReference, fromLocalInput, matchesSubmittedDraft,
  newPolicyDraft, newReference, numericInput, prospectivePolicyDraft, replaceUnsavedMeasurement, toLocalInput,
  validatePolicyDraft, validationConfiguration, WINDOW_PRESETS, withPracticeFrequency,
  type DomainPolicyDraft, type DraftIdentities, type DraftIssue, type MeasurementKind, type ReferenceDraft } from "@/lib/domain-policy-draft";
import { configurePersonalDomain, createPersonalDomain, describeCondition, DomainsMutationError,
  personalPolicySelection, type PersonalDomain } from "@/lib/domains-api";

const inputClass = "w-full min-w-0 rounded-lg border border-border bg-background p-2 text-sm";
const buttonClass = "rounded-lg border border-border px-4 py-2 text-sm font-semibold disabled:opacity-50";
const groupClass = "rounded-xl border border-border/60 p-4 space-y-3 min-w-0";
const kinds: Record<MeasurementKind, string> = { duration: "Duration", repetitions: "Repetitions", count: "Whole-number count",
  quantity: "Quantity or distance", completion: "Completion", frequency: "Practice frequency" };
const intents = { develop: "Develop a skill", maintain: "Maintain capability", general_wellbeing: "General wellbeing", unknown: "Not yet decided" };
export const UNSPECIFIED_CAPABILITY = "I'll define this later.";
/** An explicit user choice in the existing text contract; never an inferred goal. */
export function chooseCapabilityLater(goal: DomainPolicyDraft["goal"], later: boolean): DomainPolicyDraft["goal"] {
  return { ...goal, desiredCapability: later ? UNSPECIFIED_CAPABILITY : "" };
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1 text-sm"><span className="font-semibold">{label}</span>{children}</label>;
}
function NumberField({ label, value, integer, onChange }: { label: string; value: number; integer: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : "");
  useEffect(() => { if (Number.isFinite(value) && Number(text) !== value) setText(String(value)); }, [value]);
  return <Field label={label}><input className={inputClass} type="number" min="0" step={integer ? "1" : "any"} value={text}
    onChange={event => { const raw = event.target.value; setText(raw); try { onChange(numericInput(raw, integer)); } catch { onChange(NaN); } }} /></Field>;
}
function InstantField({ label, value, onChange }: { label: string; value?: string; onChange: (value: string | undefined) => void }) {
  const [text, setText] = useState(value ? toLocalInput(value) : "");
  const [error, setError] = useState("");
  useEffect(() => { if (!error && value && toLocalInput(value) !== text) setText(toLocalInput(value)); }, [value]);
  return <div><Field label={label}><input className={inputClass} type="datetime-local" value={text} onChange={event => {
    const raw = event.target.value; setText(raw);
    if (!raw) { setError(""); onChange(undefined); return; }
    try { onChange(fromLocalInput(raw)); setError(""); } catch (failure) {
      setError((failure as Error).message); onChange("invalid-local-time");
    }
  }} /></Field>{error && <p role="alert" className="text-sm">{error}</p>}</div>;
}
function ConditionEditor({ condition, measurement, index, onChange }: { condition: TypedCondition;
  measurement?: MeasurementDefinition; index: number; onChange: (condition: TypedCondition) => void }) {
  const label = `${measurement?.displayName ?? "Measurement"} (${measurement?.unit.customLabel ?? condition.unitId})`;
  const basis = condition.basis.kind === "per_event" ? "per practice event" : `per ${condition.basis.windowDays} days`;
  if (condition.valueType === "boolean") return <Field label={`${label}, ${basis}`}><select className={inputClass}
    value={String(condition.constraint.value)} onChange={event => onChange({ ...condition, constraint: { operator: "eq", value: event.target.value === "true" } })}>
    <option value="true">Completed</option><option value="false">Not completed</option></select></Field>;
  const constraint = condition.constraint;
  return <div className="space-y-2" data-condition={index}><p className="text-sm">{label} · {basis}{condition.periodAggregation ? " · sum of practice amounts" : ""}</p>
    <Field label={`Comparison for ${measurement?.displayName ?? "measurement"}`}><select className={inputClass} value={constraint.operator}
      onChange={event => { const op = event.target.value as "gte" | "lte" | "eq" | "range";
        const value = constraint.operator === "range" ? constraint.min : constraint.value;
        onChange({ ...condition, constraint: op === "range" ? { operator: op, min: value, max: value } : { operator: op, value } }); }}>
      <option value="gte">At least</option><option value="lte">At most</option><option value="eq">Exactly</option><option value="range">Within a range</option></select></Field>
    {constraint.operator === "range" ? <div className="grid sm:grid-cols-2 gap-2">
      <NumberField label={`${label} minimum`} integer={condition.valueType === "integer"} value={constraint.min}
        onChange={value => onChange({ ...condition, constraint: { ...constraint, min: value } })} />
      <NumberField label={`${label} maximum`} integer={condition.valueType === "integer"} value={constraint.max}
        onChange={value => onChange({ ...condition, constraint: { ...constraint, max: value } })} /></div> :
      <NumberField label={`${label} target`} integer={condition.valueType === "integer"} value={constraint.value}
        onChange={value => onChange({ ...condition, constraint: { ...constraint, value } })} />}
  </div>;
}
function ConditionsEditor({ conditions, draft, onChange }: { conditions: TypedCondition[]; draft: DomainPolicyDraft; onChange: (conditions: TypedCondition[]) => void }) {
  return <div className="space-y-4">{conditions.map((condition, index) => <ConditionEditor key={`${index}-${condition.measurementId}-${condition.valueType}`}
    condition={condition} measurement={draft.measurements.find(m => m.measurementId === condition.measurementId)} index={index}
    onChange={value => onChange(conditions.map((old, i) => i === index ? value : old))} />)}</div>;
}
function FrequencyDefinition({ measurement, onChange }: { measurement: Extract<MeasurementDefinition, { kind: "frequency" }>;
  onChange: (measurement: Extract<MeasurementDefinition, { kind: "frequency" }>) => void }) {
  return <div className="grid sm:grid-cols-2 gap-2"><Field label="Frequency counts"><select className={inputClass} value={measurement.countBy}
    onChange={event => { const countBy = event.target.value as "events" | "distinct_days";
      onChange({ ...measurement, countBy, displayName: countBy === "events" ? "Practice events" : "Practice days",
        meaning: countBy === "events" ? "Any logged practice events in the chosen period" : "Distinct local days with any logged practice",
        unit: { ...measurement.unit, dimension: countBy === "events" ? "events" : "days", customLabel: countBy === "events" ? "events" : "days" } }); }}>
    <option value="events">Any logged practice events</option><option value="distinct_days">Distinct practice days</option></select></Field>
    <Field label="Frequency period"><select className={inputClass} value={measurement.scope.windowDays}
      onChange={event => onChange({ ...measurement, scope: { kind: "period", windowDays: Number(event.target.value) } })}>
      {WINDOW_PRESETS.map(days => <option key={days} value={days}>{days} days</option>)}</select></Field></div>;
}
function ReferenceEditor({ reference, draft, onChange, onRemove }: { reference: ReferenceDraft; draft: DomainPolicyDraft;
  onChange: (value: ReferenceDraft) => void; onRemove: () => void }) {
  const change = (next: ReferenceDraft) => onChange(editReference(reference, next));
  return <fieldset className={groupClass}><legend className="font-semibold px-1">Reference benchmark</legend>
    <Field label="Reference purpose"><select className={inputClass} value={reference.purpose} onChange={event => change({ ...reference,
      purpose: event.target.value as ReferenceDraft["purpose"] })}>{(["develop", "maintain", "general_wellbeing"] as const).map(intent =>
        <option key={intent} value={intent}>{intents[intent]}</option>)}</select></Field>
    <Field label="Where this reference applies"><textarea className={inputClass} value={reference.applicability.description}
      onChange={event => change({ ...reference, applicability: { ...reference.applicability, description: event.target.value } })} /></Field>
    <Field label="Reference status"><select className={inputClass} value={reference.status} onChange={event => {
      const { status: _status, ...common } = reference;
      const { conditions: _conditions, note: _note, ...fields } = common as typeof common & { conditions?: TypedCondition[]; note?: string };
      change(event.target.value === "known" ? { ...fields, status: "known", conditions: structuredClone(draft.targets.normal.conditions) } :
        { ...fields, status: event.target.value as "unknown" | "not_applicable" });
    }}><option value="unknown">Unknown; no minimum inferred</option><option value="known">Declared benchmark</option><option value="not_applicable">Not applicable</option></select></Field>
    {reference.status === "known" ? <ConditionsEditor draft={draft} conditions={reference.conditions}
      onChange={conditions => change({ ...reference, conditions })} /> : <Field label="Reference note (optional)"><textarea className={inputClass} value={reference.note ?? ""}
      onChange={event => change({ ...reference, note: event.target.value || undefined })} /></Field>}
    <div className="grid sm:grid-cols-2 gap-2"><Field label="Evidence category"><select className={inputClass} value={reference.evidence.category}
      onChange={event => change({ ...reference, evidence: { ...reference.evidence, category: event.target.value as ReferenceDraft["evidence"]["category"] } })}>
      {["personal", "published", "professional", "community", "unspecified"].map(category => <option key={category}>{category}</option>)}</select></Field>
      <Field label="Confidence"><select className={inputClass} value={reference.evidence.confidence} onChange={event => change({ ...reference,
        evidence: { ...reference.evidence, confidence: event.target.value as ReferenceDraft["evidence"]["confidence"] } })}>
        {["unknown", "low", "moderate", "high"].map(confidence => <option key={confidence}>{confidence}</option>)}</select></Field></div>
    <Field label="Source description (optional)"><input className={inputClass} value={reference.evidence.source?.description ?? ""} onChange={event => change({ ...reference,
      evidence: { ...reference.evidence, source: event.target.value || reference.evidence.source?.url ?
        { ...reference.evidence.source, description: event.target.value } : undefined } })} /></Field>
    <Field label="Source address (optional)"><input className={inputClass} value={reference.evidence.source?.url ?? ""} onChange={event => change({ ...reference,
      evidence: { ...reference.evidence, source: event.target.value || reference.evidence.source?.description ?
        { description: reference.evidence.source?.description ?? "", url: event.target.value || undefined } : undefined } })} /></Field>
    <p className="text-sm">{reference.evidence.review.status === "reviewed" ? "Saved evidence review is preserved until you change this reference." : "This evidence has not been reviewed."}</p>
    {reference.applicability.taskVariantId && <p className="text-sm">Saved task variant and its conditions are preserved.</p>}
    {reference.applicability.taskConditions?.map(condition => <p className="text-sm" key={condition.conditionId}>{condition.description}</p>)}
    <button type="button" className={buttonClass} onClick={onRemove}>Remove reference from this future version</button>
  </fieldset>;
}
export function DomainPolicyReview({ draft }: { draft: DomainPolicyDraft }) {
  const c = validationConfiguration(draft);
  const validTime = Number.isFinite(Date.parse(draft.effectiveFrom));
  return <section className={groupClass} data-testid="policy-draft-review"><h3 className="font-semibold">Review your future configuration</h3>
    <p className="break-words">{draft.displayName || "Unnamed domain"} · {intents[draft.goal.intent]}</p>
    <p className="whitespace-pre-wrap break-words">{draft.goal.desiredCapability}</p>
    <p>Starts: {validTime ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: draft.boundary.timezone }).format(new Date(draft.effectiveFrom)) : "Choose a valid future time"}
      {" "}({draft.boundary.timezone})</p>
    {validTime && <p className="text-sm break-all">Selected instant: {draft.effectiveFrom}</p>}
    <ul className="list-disc pl-5">{draft.targets.normal.conditions.map((condition, index) => <li key={index}>{describeCondition(condition, c)}</li>)}</ul>
    {draft.targets.adapted && <div><h4 className="font-semibold">Adapted target · {draft.targets.adapted.duration}</h4>
      <ul className="list-disc pl-5">{draft.targets.adapted.target.conditions.map((condition, index) => <li key={index}>{describeCondition(condition, c)}</li>)}</ul>
      <p className="text-sm break-all">Adaptation starts: {draft.targets.adapted.effectiveFrom}</p>
      {draft.targets.adapted.reviewAt && <p className="text-sm break-all">Adaptation review: {draft.targets.adapted.reviewAt}</p>}
      {draft.targets.adapted.reason && <p className="whitespace-pre-wrap break-words">{draft.targets.adapted.reason}</p>}
      <p>Review does not end it automatically.</p></div>}
    {draft.targets.upperRecovery && <div><h4 className="font-semibold">Upper recovery guidance</h4>
      <ul className="list-disc pl-5">{draft.targets.upperRecovery.conditions.map((condition, index) => <li key={index}>{describeCondition(condition, c)}</li>)}</ul>
      {draft.targets.upperRecovery.guidance && <p className="whitespace-pre-wrap break-words">{draft.targets.upperRecovery.guidance}</p>}
      <p>Declared guidance does not calculate a health-risk score.</p></div>}
    {draft.references.map(reference => <div key={reference.referenceId}><p>{intents[reference.purpose]} reference: {reference.applicability.description}</p>
      {reference.status === "known" ? <ul className="list-disc pl-5">{reference.conditions.map((condition, index) => <li key={index}>{describeCondition(condition, c)}</li>)}</ul> :
        <p>{reference.status === "unknown" ? "Reference unknown; no minimum inferred." : "Reference not applicable."}</p>}</div>)}
    <p className="text-sm">Below-reference targets are allowed. Comparisons will be returned after saving. No activity score is calculated.</p>
  </section>;
}
export function DomainPolicyEditor({ draft, ids, previous, onChange }: { draft: DomainPolicyDraft; ids: DraftIdentities;
  previous?: DomainConfiguration; onChange: (draft: DomainPolicyDraft) => void }) {
  const [referencePurpose, setReferencePurpose] = useState<ReferenceDraft["purpose"] | "">("");
  const update = (patch: Partial<DomainPolicyDraft>) => onChange({ ...draft, ...patch });
  const goal = draft.goal;
  const primary = draft.measurements[0];
  const replaceFrequency = (measurement: Extract<MeasurementDefinition, { kind: "frequency" }>) => {
    // Only an unsaved creator exposes definition controls. All dependent conditions retain their values.
    const remap = (conditions: TypedCondition[]) => conditions.map(condition => condition.measurementId === measurement.measurementId ?
      { ...condition, basis: measurement.scope, unitId: measurement.unit.unitId } : condition);
    update({ measurements: draft.measurements.map(m => m.measurementId === measurement.measurementId ? measurement : m),
      targets: { ...draft.targets, normal: { ...draft.targets.normal, conditions: remap(draft.targets.normal.conditions) },
        ...(draft.targets.adapted ? { adapted: { ...draft.targets.adapted, target: { ...draft.targets.adapted.target, conditions: remap(draft.targets.adapted.target.conditions) } } } : {}),
        ...(draft.targets.upperRecovery ? { upperRecovery: { ...draft.targets.upperRecovery, conditions: remap(draft.targets.upperRecovery.conditions) } } : {}) },
      references: draft.references.map(r => r.status === "known" ? { ...r, conditions: remap(r.conditions), evidence: { ...r.evidence, review: { status: "unreviewed" } } } : r) });
  };
  return <div className="space-y-5 min-w-0">
    <fieldset className={groupClass}><legend className="px-1 font-semibold">Your goal</legend>
      <Field label="Domain name"><input className={inputClass} maxLength={500} value={draft.displayName} readOnly={!!previous}
        onChange={event => update({ displayName: event.target.value })} required /></Field>
      {previous && <p className="text-sm">The saved name stays the same in this future configuration.</p>}
      <Field label="What are you aiming for?"><select className={inputClass} value={goal.intent}
        onChange={event => update({ goal: { ...goal, intent: event.target.value as DomainPolicyDraft["goal"]["intent"] } })}>
        {Object.entries(intents).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={goal.desiredCapability === UNSPECIFIED_CAPABILITY}
        onChange={event => update({ goal: chooseCapabilityLater(goal, event.target.checked) })} />I'll define this later</label>
      <Field label="Desired capability"><textarea className={inputClass} value={goal.desiredCapability}
        disabled={goal.desiredCapability === UNSPECIFIED_CAPABILITY} required={goal.desiredCapability !== UNSPECIFIED_CAPABILITY}
        onChange={event => update({ goal: { ...goal, desiredCapability: event.target.value } })} /></Field>
      {goal.desiredCapability === UNSPECIFIED_CAPABILITY && <p className="text-sm">Capability is explicitly unspecified. Your intent can remain undecided; no minimum or progress claim is inferred.</p>}
      <Field label="Your private motivation (optional)"><textarea className={inputClass} value={goal.privateMotivation ?? ""}
        onChange={event => update({ goal: { ...goal, privateMotivation: event.target.value || undefined } })} /></Field>
      <Field label="Current capability assessment (optional)"><textarea className={inputClass} value={goal.currentCapability?.assessment ?? ""}
        onChange={event => update({ goal: { ...goal, currentCapability: event.target.value ?
          { assessedAt: new Date().toISOString(), assessment: event.target.value } : undefined } })} /></Field>
      {goal.taskConditions?.map(condition => <p key={condition.conditionId} className="text-sm">{condition.description}</p>)}
    </fieldset>
    <fieldset className={groupClass}><legend className="px-1 font-semibold">What you measure</legend>
      {previous ? <><p className="text-sm">Saved measurement definitions, units, task variants and qualifying-practice rules stay unchanged.</p>
        {draft.measurements.map(m => <p key={m.measurementId}>{m.displayName}: {kinds[m.kind]} · {m.unit.customLabel ?? m.unit.unitId}
          {" · "}{m.scope.kind === "period" ? `${m.scope.windowDays} days` : "per practice event"}</p>)}
        {draft.taskVariants.map(variant => <p key={variant.variantId}>{variant.displayName}: {variant.taskConditions.map(c => c.description).join("; ")}</p>)}</> : <>
        <Field label="Primary measurement"><select className={inputClass} value={primary.kind} onChange={event =>
          onChange(replaceUnsavedMeasurement(draft, event.target.value as MeasurementKind, ids))}>{Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></Field>
        <p className="text-sm">Changing the primary measurement resets unsaved targets and references.</p>
        <Field label="Measurement name"><input className={inputClass} value={primary.displayName} onChange={event => update({ measurements:
          draft.measurements.map((m, index) => index === 0 ? { ...m, displayName: event.target.value } : m) })} /></Field>
        <Field label="What does a recorded value mean?"><textarea className={inputClass} value={primary.meaning} onChange={event => update({ measurements:
          draft.measurements.map((m, index) => index === 0 ? { ...m, meaning: event.target.value } : m) })} /></Field>
        {primary.kind === "frequency" ? <FrequencyDefinition measurement={primary} onChange={replaceFrequency} /> : primary.kind !== "completion" && <>
          <Field label="Unit label"><input className={inputClass} value={primary.unit.customLabel ?? ""} onChange={event => update({ measurements:
            draft.measurements.map((m, index) => { if (index !== 0) return m;
              const copy = structuredClone(m); copy.unit.customLabel = event.target.value; return copy; }) })} /></Field>
          {primary.kind === "quantity" && <Field label="Quantity type"><select className={inputClass} value={primary.unit.dimension} onChange={event => update({ measurements:
            draft.measurements.map((m, index) => index === 0 && m.kind === "quantity" ? { ...m, unit: { ...m.unit, dimension: event.target.value as "quantity" | "distance" } } : m) })}>
            <option value="quantity">Quantity</option><option value="distance">Distance</option></select></Field>}
          <Field label="Amount target applies to"><select className={inputClass} value={draft.targets.normal.conditions[0].basis.kind}
            onChange={event => { const condition = draft.targets.normal.conditions[0]; const copy = { ...condition };
              if (event.target.value === "per_event") { copy.basis = { kind: "per_event" }; delete copy.periodAggregation; }
              else { copy.basis = { kind: "period", windowDays: 7 }; copy.periodAggregation = { sourceBasis: "per_event", method: "sum" }; }
              update({ targets: { ...draft.targets, normal: { ...draft.targets.normal, conditions: [copy, ...draft.targets.normal.conditions.slice(1)] } } }); }}>
            <option value="per_event">Each practice event</option><option value="period">Sum of practice amounts over a period</option></select></Field>
          {draft.targets.normal.conditions[0].basis.kind === "period" && <Field label="Amount total period"><select className={inputClass}
            value={draft.targets.normal.conditions[0].basis.windowDays} onChange={event => update({ targets: { ...draft.targets,
              normal: { ...draft.targets.normal, conditions: draft.targets.normal.conditions.map((c, i) => i === 0 ? { ...c, basis: { kind: "period", windowDays: Number(event.target.value) } } : c) } } })}>
            {WINDOW_PRESETS.map(days => <option key={days} value={days}>{days} days</option>)}</select></Field>}</>}
        {primary.kind !== "frequency" && <><label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.measurements.some(m => m.measurementId === ids.frequency)}
          onChange={event => onChange(withPracticeFrequency(draft, ids, event.target.checked))} />Also track practice frequency</label>
          {draft.measurements.filter((m): m is Extract<MeasurementDefinition, { kind: "frequency" }> => m.kind === "frequency")
            .map(m => <FrequencyDefinition key={m.measurementId} measurement={m} onChange={replaceFrequency} />)}</>}
        <p className="text-sm">Frequency counts any logged practice. No qualifying floor is inferred from a reference benchmark.</p>
      </>}
    </fieldset>
    <fieldset className={groupClass}><legend className="px-1 font-semibold">Normal target</legend>
      <ConditionsEditor draft={draft} conditions={draft.targets.normal.conditions} onChange={conditions => update({ targets: { ...draft.targets,
        normal: { ...draft.targets.normal, conditions } } })} />
      <p className="text-sm">Zero and below-reference amounts are allowed. Whole-number measures require whole numbers.</p>
      {draft.targets.stretch && <details><summary>Saved stretch target (preserved)</summary><ul className="list-disc pl-5">{draft.targets.stretch.conditions.map((c, i) =>
        <li key={i}>{describeCondition(c, validationConfiguration(draft))}</li>)}</ul></details>}
    </fieldset>
    <fieldset className={groupClass}><legend className="px-1 font-semibold">Adapted target</legend>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!draft.targets.adapted} onChange={event => {
        const targets = structuredClone(draft.targets); if (event.target.checked) targets.adapted = {
          target: { targetId: ids.adapted, conditions: structuredClone(draft.targets.normal.conditions) }, effectiveFrom: draft.effectiveFrom, duration: "temporary" };
        else delete targets.adapted; update({ targets });
      }} />Include an adapted target in this future version</label>
      {draft.targets.adapted && <>
        <ConditionsEditor draft={draft} conditions={draft.targets.adapted.target.conditions} onChange={conditions => update({ targets: { ...draft.targets,
          adapted: { ...draft.targets.adapted!, target: { ...draft.targets.adapted!.target, conditions } } } })} />
        <Field label="Adaptation duration"><select className={inputClass} value={draft.targets.adapted.duration} onChange={event => update({ targets: { ...draft.targets,
          adapted: { ...draft.targets.adapted!, duration: event.target.value as "temporary" | "ongoing" } } })}><option value="temporary">Temporary</option><option value="ongoing">Ongoing</option></select></Field>
        <InstantField label="Adaptation starts (browser local time)" value={draft.targets.adapted.effectiveFrom} onChange={value => update({ targets: { ...draft.targets,
          adapted: { ...draft.targets.adapted!, effectiveFrom: value ?? "" } } })} />
        <InstantField label="Adaptation review (optional, browser local time)" value={draft.targets.adapted.reviewAt} onChange={value => update({ targets: { ...draft.targets,
          adapted: { ...draft.targets.adapted!, reviewAt: value } } })} />
        <Field label="Adaptation reason (optional)"><textarea className={inputClass} value={draft.targets.adapted.reason ?? ""} onChange={event => update({ targets: { ...draft.targets,
          adapted: { ...draft.targets.adapted!, reason: event.target.value || undefined } } })} /></Field>
      </>}
      <p className="text-sm">Review never ends an adaptation or raises a target automatically. Unchecking removes it from this future version.</p>
    </fieldset>
    <fieldset className={groupClass}><legend className="px-1 font-semibold">Upper recovery guidance</legend>
      {(draft.measurements.some(m => m.valueType !== "boolean") || draft.targets.upperRecovery) ? <label className="flex gap-2 text-sm">
        <input type="checkbox" checked={!!draft.targets.upperRecovery} onChange={event => { const targets = structuredClone(draft.targets);
          if (event.target.checked) targets.upperRecovery = { conditions: draft.measurements.filter(m => m.valueType !== "boolean").map(m => conditionFor(m, true)) };
          else delete targets.upperRecovery; update({ targets }); }} />Include declared recovery guidance</label> : <p>No numeric upper limit applies to a completion-only measurement.</p>}
      {draft.targets.upperRecovery && <><ConditionsEditor draft={draft} conditions={draft.targets.upperRecovery.conditions} onChange={conditions => update({ targets: { ...draft.targets,
        upperRecovery: { ...draft.targets.upperRecovery!, conditions } } })} />
        <Field label="Recovery guidance (optional)"><textarea className={inputClass} value={draft.targets.upperRecovery.guidance ?? ""} onChange={event => update({ targets: { ...draft.targets,
          upperRecovery: { ...draft.targets.upperRecovery!, guidance: event.target.value || undefined } } })} /></Field></>}
      <p className="text-sm">This records your chosen guidance; it is not an injury or burnout assessment.</p>
    </fieldset>
    <section className="space-y-3"><h3 className="font-semibold">Reference benchmarks</h3><p className="text-sm">References are optional and goal-specific. No scientific minimum is inferred.</p>
      {draft.references.map((reference, index) => <ReferenceEditor key={reference.referenceId} reference={reference} draft={draft}
        onChange={value => update({ references: draft.references.map((old, i) => i === index ? value : old) })}
        onRemove={() => update({ references: draft.references.filter((_, i) => i !== index) })} />)}
      <Field label="Purpose for a new reference"><select className={inputClass} value={referencePurpose}
        onChange={event => setReferencePurpose(event.target.value as ReferenceDraft["purpose"] | "")}>
        <option value="">Choose the reference purpose</option>{(["develop", "maintain", "general_wellbeing"] as const).map(intent =>
          <option key={intent} value={intent}>{intents[intent]}</option>)}</select></Field>
      <button type="button" className={buttonClass} disabled={!referencePurpose} onClick={() => {
        if (referencePurpose) update({ references: [...draft.references, newReference(crypto.randomUUID(), referencePurpose)] });
      }}>Add reference benchmark</button>
    </section>
    <fieldset className={groupClass}><legend className="px-1 font-semibold">Start and review</legend>
      <p className="text-sm">Day starts at {String(draft.boundary.dayStartHour).padStart(2, "0")}:00 in {draft.boundary.timezone}. These saved day settings stay unchanged here.</p>
      <p className="text-sm">Date inputs use your browser timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. The review shows the same instant in {draft.boundary.timezone}.</p>
      <InstantField label="Configuration starts (browser local time)" value={draft.effectiveFrom} onChange={value => update({ effectiveFrom: value ?? "",
        ...(!previous ? { review: { ...draft.review, anchorAt: value ?? "" } } : {}) })} />
      {previous && <p className="text-sm">This starts after latest saved version {previous.revision}, including any scheduled change.</p>}
      <p className="text-sm">Choose at least 15 minutes from now. Saving schedules this configuration; the server decides when it becomes active.</p>
      <p className="text-sm">Review cadence: every {draft.review.intervalDays} days. Saved review history is preserved; a review does not automatically change a target.</p>
      <InstantField label="Next review (optional, browser local time)" value={draft.review.nextReviewAt} onChange={value => update({ review: { ...draft.review, nextReviewAt: value } })} />
    </fieldset>
    <DomainPolicyReview draft={draft} />
  </div>;
}
export function DomainPolicyFormNotice({ issues, error, pending, needsReconciliation }: {
  issues: DraftIssue[]; error?: string; pending: boolean; needsReconciliation: boolean }) {
  return <>{pending && <p role="status">Saving your future configuration…</p>}
    {(error || issues.length > 0) && <div role="alert" className={groupClass}>{error && <p>{error}</p>}
      {issues.length > 0 && <ul className="list-disc pl-5">{issues.map((issue, index) => <li key={index} className="break-words">{policyIssueLabel(issue.path)}: {issue.message}</li>)}</ul>}</div>}
    {needsReconciliation && <p className="text-sm">Saving is paused until your owned domains are refreshed. The first request may already have been saved.</p>}</>;
}
export function policyIssueLabel(path: string): string {
  const field = path.replace(/^(configuration|next)\./, "");
  if (field === "reason") return "Change reason";
  if (field === "displayName") return "Domain name";
  if (field === "effectiveFrom" || field === "effectiveAt") return "Configuration start";
  if (field.startsWith("goal.desiredCapability")) return "Desired capability";
  if (field.startsWith("goal.privateMotivation")) return "Private motivation";
  if (field.startsWith("goal.currentCapability")) return "Current capability assessment";
  if (field.startsWith("goal")) return "Goal";
  if (field.startsWith("targets.normal")) return "Normal target";
  if (field.startsWith("targets.adapted")) return "Adapted target";
  if (field.startsWith("targets.upperRecovery")) return "Upper recovery guidance";
  if (field.startsWith("targets.stretch")) return "Saved stretch target";
  if (field.startsWith("references")) { const index = /^references\.(\d+)/.exec(field); return index ? `Reference ${Number(index[1]) + 1}` : "References"; }
  if (field.startsWith("measurements")) return "Measurement";
  if (field.startsWith("review")) return "Review schedule";
  if (field.startsWith("boundary")) return "Day settings";
  if (field === "expectedPolicyVersionId") return "Latest saved version";
  return "Configuration";
}
export type DomainPolicyFormProps = { ownerId: string; boundary: DomainPolicyDraft["boundary"]; previous?: DomainConfiguration;
  domainId?: string; latestPolicyVersionId?: string | null; onSaved: (domain: PersonalDomain) => void; onCancel: () => void;
  onReconcile: (slug: string | undefined, signal: AbortSignal) => Promise<PersonalDomain | null> };
export default function DomainPolicyForm({ ownerId, boundary, previous, domainId, latestPolicyVersionId, onSaved, onCancel, onReconcile }: DomainPolicyFormProps) {
  const [ids] = useState(() => draftIdentities());
  const [base] = useState(previous);
  const [lastVerifiedLatest, setLastVerifiedLatest] = useState<string | null>(() =>
    latestPolicyVersionId !== undefined ? latestPolicyVersionId : base?.policyVersionId ?? null);
  useEffect(() => { if (latestPolicyVersionId !== undefined) setLastVerifiedLatest(latestPolicyVersionId); }, [latestPolicyVersionId]);
  const [draft, setDraft] = useState(() => base ? prospectivePolicyDraft(base, Date.now()) : newPolicyDraft(boundary, ids, Date.now()));
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<DraftIssue[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [needsReconciliation, setNeedsReconciliation] = useState(false);
  const [stale, setStale] = useState(false);
  const lifetime = useRef({ ownerId, alive: true, generation: 0, pending: false, controller: undefined as AbortController | undefined });
  const attempted = useRef<{ draft: DomainPolicyDraft; slug?: string } | null>(null);
  useEffect(() => {
    const session = lifetime.current; session.alive = true;
    return () => { session.alive = false; session.generation++; session.controller?.abort(); attempted.current = null; };
  }, [ownerId]);
  const current = () => lifetime.current.alive && lifetime.current.ownerId === ownerId;
  const verifiedLatest = latestPolicyVersionId !== undefined ? latestPolicyVersionId : lastVerifiedLatest;
  const latestChanged = !!base && verifiedLatest !== null && base.policyVersionId !== verifiedLatest;
  const latestMissing = !!base && verifiedLatest === null;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); const session = lifetime.current;
    if (!current() || session.pending || needsReconciliation || stale || latestChanged || latestMissing) return;
    if (base && !domainId) { setError("This saved domain could not be identified. Reload it before saving."); return; }
    const found = validatePolicyDraft(draft, reason, Date.now(), base); setIssues(found); setError("");
    if (found.length) return;
    const snapshot = structuredClone(draft), slug = base ? undefined : domainSlug(draft.displayName, ids.slugSuffix);
    attempted.current = { draft: snapshot, slug }; session.pending = true; setPending(true);
    const generation = ++session.generation; session.controller = new AbortController();
    try {
      const saved = base && domainId ? await configurePersonalDomain(ownerId, domainId, { expectedPolicyVersionId: base.policyVersionId,
        configuration: snapshot, reason }, session.controller.signal) : await createPersonalDomain(ownerId, { slug: slug!, configuration: snapshot, reason }, session.controller.signal);
      if (current() && session.generation === generation) { attempted.current = null; onSaved(saved); }
    } catch (failure) {
      if (current() && session.generation === generation) {
        const api = failure instanceof DomainsMutationError ? failure : new DomainsMutationError(503, true);
        setError(api.message); setIssues(api.issues);
        setNeedsReconciliation(api.needsReconciliation || api.issues.some(issue => issue.code === "version_conflict"));
      }
    } finally { if (current() && session.generation === generation) { session.pending = false; setPending(false); } }
  };
  const reconcile = async () => {
    const session = lifetime.current;
    if (!current() || session.pending || !attempted.current) return;
    session.pending = true; setPending(true); const generation = ++session.generation;
    session.controller = new AbortController();
    try {
      const saved = await onReconcile(attempted.current.slug, session.controller.signal);
      if (!current() || session.generation !== generation) return;
      const latest = saved ? personalPolicySelection(saved).latest?.configuration : undefined;
      if (saved && latest && matchesSubmittedDraft(latest, attempted.current.draft) &&
        (base ? latest.previousVersionId === base.policyVersionId : latest.revision === 1)) { attempted.current = null; onSaved(saved); return; }
      if (base && (!latest || latest.policyVersionId !== base.policyVersionId) || !base && saved) {
        setNeedsReconciliation(false); setStale(true); setError("The saved domain differs from this draft. Cancel and review its latest configuration before making another change.");
      } else { setNeedsReconciliation(false); setError("Your owned domains were refreshed. No matching save was found; you may deliberately save this draft again."); }
    } catch { if (current() && session.generation === generation) setError("The refresh could not be verified. Saving remains paused."); }
    finally { if (current() && session.generation === generation) { session.pending = false; setPending(false); } }
  };
  return <form className="space-y-5 min-w-0" onSubmit={submit} data-testid="domain-policy-form">
    <h2 className="text-xl font-semibold">{base ? "Schedule a new configuration" : "Add a personal domain"}</h2>
    <fieldset disabled={pending || needsReconciliation || stale || latestChanged || latestMissing} className="space-y-5 min-w-0">
      <DomainPolicyEditor draft={draft} ids={ids} previous={base} onChange={setDraft} />
      <Field label="Reason for this change"><textarea className={inputClass} value={reason} maxLength={500} required onChange={event => setReason(event.target.value)} /></Field>
    </fieldset>
    {latestChanged && <p role="alert">A newer saved version was loaded. Cancel and reopen the form to start from that version.</p>}
    {latestMissing && <p role="alert">The saved configuration is no longer available. This draft is preserved, but saving is paused. Refresh your domains before continuing.</p>}
    <DomainPolicyFormNotice issues={issues} error={error} pending={pending} needsReconciliation={needsReconciliation} />
    <div className="flex flex-wrap gap-3"><button type="submit" className={buttonClass} disabled={pending || needsReconciliation || stale || latestChanged || latestMissing}>
      {pending ? "Saving…" : "Save future configuration"}</button>
      {needsReconciliation && !stale && <button type="button" className={buttonClass} onClick={() => { void reconcile(); }} disabled={pending}>Refresh my domains</button>}
      <button type="button" className={buttonClass} onClick={onCancel} disabled={pending || needsReconciliation}>Cancel and discard draft</button></div>
    <p className="text-sm">Private drafts stay here until saved or discarded. You can log activity for personal domains. Qualification and scores are not calculated yet.</p>
  </form>;
}
