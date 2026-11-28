import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore, type Domain, type Deviation, type DeviationDraft, type DeviationPatch } from '@/store';
import { DeviationText } from '@/components/session-text';
import { isActivityOwner } from '@/lib/activities-api';
import { allSelection, browserDateTimeValue, compareBreakInstants, formatBreakTime, occurrenceForInstant, orderedSelection,
  resolveBreakTime, sameInstant, wallTimeCandidates } from '@/lib/deviation-time';
import type { PersonalDeviation, PersonalDeviationCreate, PersonalDeviationEdit } from '@/lib/deviation-v2-api';

const DOMAIN_LABEL: Record<Domain, string> = {
  'martial-arts': 'Martial Arts',
  meditation: 'Meditation',
  fitness: 'Fitness',
  music: 'Music',
};

/**
 * Convert a Date (or ISO string) to a `YYYY-MM-DDTHH:mm` string suitable for
 * `<input type="datetime-local">` in the user's local timezone. The browser
 * input does not understand offsets, so we strip them and re-attach the
 * local offset on submit via `new Date(localStr).toISOString()`.
 */
function toLocalInputValue(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(local: string): string {
  // `new Date('YYYY-MM-DDTHH:mm')` is interpreted in local time; toISOString
  // re-encodes as UTC with `Z` offset, which satisfies z.string().datetime({ offset: true }).
  return new Date(local).toISOString();
}

interface DeviationFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the form edits this deviation. When undefined, it creates a new one. */
  editing?: Deviation | null;
  onSubmit: (draftOrPatch: DeviationDraft | DeviationPatch) => Promise<unknown>;
}

const DOMAINS: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];

export function DeviationForm(props: DeviationFormProps) {
  const detail = useAppStore(s => props.editing ? s.deviationDetails[props.editing.id] : undefined);
  const fetchDetail = useAppStore(s => s.fetchDeviationDetail);
  const demo = useAppStore(s => s.demoState !== "default");
  const [freshOpen, setFreshOpen] = useState(false);
  useEffect(() => {
    let active = true; setFreshOpen(false);
    if (props.open && props.editing && !demo)
      void fetchDetail(props.editing.id).then(() => { if (active) setFreshOpen(true); });
    return () => { active = false; };
  }, [props.open, props.editing?.id, demo, fetchDetail]);
  if (props.open && props.editing && !demo && (!freshOpen || detail?.status !== "ready")) {
    return <Dialog open={props.open} onOpenChange={props.onOpenChange}><DialogContent>
      <DialogHeader><DialogTitle>Load saved deviation</DialogTitle><DialogDescription>
        Load the complete original reason before editing.
      </DialogDescription></DialogHeader><DeviationText deviation={{ ...props.editing, textComplete: false }} force />
      <Button disabled>Save changes</Button></DialogContent></Dialog>;
  }
  return <DeviationFormFields {...props} editing={!demo && props.editing ? detail?.value ?? null : props.editing} />;
}
function DeviationFormFields({ open, onOpenChange, editing, onSubmit }: DeviationFormProps) {
  const isEdit = !!editing;
  const [domain, setDomain] = useState<Domain>('fitness');
  const [reason, setReason] = useState('');
  const [reasonDirty, setReasonDirty] = useState(false);
  const [changeReason, setChangeReason] = useState('');
  const detail = useAppStore(s => editing ? s.deviationDetails[editing.id] : undefined);
  const full = editing?.textComplete === false ? detail?.value : editing;
  const ready = !editing || (!!full && full.textComplete !== false);
  const [startLocal, setStartLocal] = useState(toLocalInputValue(new Date().toISOString()));
  const [endLocal, setEndLocal] = useState('');
  const [excludeFromComposite, setExcludeFromComposite] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setDomain(editing.domain as Domain);
      setReason(full?.reason ?? '');
      setStartLocal(toLocalInputValue(editing.startAt));
      setEndLocal(toLocalInputValue(editing.endAt));
      setExcludeFromComposite(editing.excludeFromComposite);
    } else {
      setDomain('fitness');
      setReason('');
      setStartLocal(toLocalInputValue(new Date().toISOString()));
      setEndLocal('');
      setExcludeFromComposite(true);
    }
    setError(null); setReasonDirty(false); setChangeReason('');
  }, [open, editing?.id]);
  useEffect(() => { if (open && ready && full && !reasonDirty) setReason(full.reason); },
    [open, ready, full?.reason, reasonDirty]);

  const handleSubmit = async () => {
    if (!ready) return;
    setError(null);
    if (!reason.trim()) {
      setError('Reason is required.');
      return;
    }
    if (isEdit && (!changeReason.trim() || changeReason.trim().length > 500)) {
      setError('Explain why you are changing this deviation (up to 500 characters).');
      return;
    }
    if (!startLocal) {
      setError('Start time is required.');
      return;
    }
    const startIso = fromLocalInputValue(startLocal);
    const endIso = endLocal ? fromLocalInputValue(endLocal) : null;
    if (endIso && new Date(endIso) <= new Date(startIso)) {
      setError('End time must be after start time.');
      return;
    }
    setSubmitting(true);
    try {
      if (isEdit) {
        const patch: DeviationPatch = {
          changeReason: changeReason.trim(),
          ...(reasonDirty ? { reason } : {}),
          startAt: startIso,
          endAt: endIso,
          excludeFromComposite,
        };
        const result = await onSubmit(patch);
        if (!result) {
          setError('Could not save changes. Please try again.');
          return;
        }
      } else {
        const draft: DeviationDraft = {
          domain,
          reason,
          startAt: startIso,
          endAt: endIso,
          excludeFromComposite,
        };
        const result = await onSubmit(draft);
        if (!result) {
          setError('Could not declare deviation. Please try again.');
          return;
        }
      }
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-deviation-form">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Deviation' : 'Declare Deviation'}</DialogTitle>
          <DialogDescription>
            Mark a domain as intentionally off-target. Active deviations can be
            excluded from the composite score and freeze the error budget while
            in effect.
          </DialogDescription>
        </DialogHeader>

        {isEdit && <div className="space-y-2">
          <Label htmlFor="deviation-change-reason">Why are you changing this deviation?</Label>
          <Textarea id="deviation-change-reason" value={changeReason} onChange={event => setChangeReason(event.target.value)}
            maxLength={500} required data-testid="input-deviation-change-reason" />
          <p className="text-sm text-muted-foreground">This explanation is saved in its edit history. The original deviation reason is separate.</p>
        </div>}
        {!ready && editing && <div><p>Load the complete saved reason before editing.</p><DeviationText deviation={editing} force /></div>}
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="deviation-domain">Domain</Label>
            <Select
              value={domain}
              onValueChange={(v) => setDomain(v as Domain)}
              disabled={isEdit}
            >
              <SelectTrigger id="deviation-domain" data-testid="select-deviation-domain">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOMAINS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {DOMAIN_LABEL[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="deviation-reason">Reason</Label>
            <Textarea
              id="deviation-reason"
              placeholder="e.g. Travel for work, knee injury, planned sabbatical"
              value={reason}
              onChange={(e) => { setReason(e.target.value); setReasonDirty(true); }}
              disabled={!ready}
              rows={3}
              data-testid="input-deviation-reason"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="deviation-start">Start</Label>
              <Input
                id="deviation-start"
                type="datetime-local"
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
                data-testid="input-deviation-start"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="deviation-end">End (optional)</Label>
              <Input
                id="deviation-end"
                type="datetime-local"
                value={endLocal}
                onChange={(e) => setEndLocal(e.target.value)}
                data-testid="input-deviation-end"
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-border/50 px-4 py-3">
            <div>
              <Label htmlFor="deviation-exclude" className="text-sm font-medium">
                Exclude from composite
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Don't drag the system score while this deviation is active.
              </p>
            </div>
            <Switch
              id="deviation-exclude"
              checked={excludeFromComposite}
              onCheckedChange={setExcludeFromComposite}
              data-testid="switch-deviation-exclude"
            />
          </div>

          {error && (
            <p className="text-sm text-status-critical" data-testid="text-deviation-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="button-deviation-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !ready}
            data-testid="button-deviation-submit"
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Declare deviation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface PersonalDeviationPracticeOption {
  domainId: string;
  displayName: string;
  active: boolean;
}

export interface PersonalDeviationFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ownerId: string;
  timezone: string;
  practices: PersonalDeviationPracticeOption[];
  editing?: PersonalDeviation | null;
  onSubmit: (input: PersonalDeviationCreate | PersonalDeviationEdit) => Promise<PersonalDeviation | null>;
  onReloadAfterUncertainCreate?: () => Promise<PersonalDeviation[]>;
}

export function PersonalDeviationPracticePicker({ practices, selectedIds, onChange, editing, disabled = false }: {
  practices: PersonalDeviationPracticeOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  editing?: PersonalDeviation | null;
  disabled?: boolean;
}) {
  const selected = new Set(selectedIds);
  const activeIds = practices.filter(practice => practice.active).map(practice => practice.domainId);
  const allSelected = activeIds.length > 0 && activeIds.every(id => selected.has(id));
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-3">
      <Label>Personal practices</Label>
      <Button type="button" size="sm" variant="outline" disabled={!activeIds.length || disabled}
        onClick={() => onChange(allSelection(selectedIds, activeIds, !allSelected))}
        data-testid="button-select-all-break-practices">{allSelected ? 'Clear active selection' : 'Select all active'}</Button>
    </div>
    <fieldset className="max-h-48 overflow-auto rounded-xl border border-border/60 p-3 space-y-2" disabled={disabled}>
      {practices.map(practice => {
        const checked = selected.has(practice.domainId);
        return <label key={practice.domainId} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={checked} disabled={!practice.active && !checked}
            onChange={event => onChange(orderedSelection(selectedIds, practice.domainId, event.target.checked))}
            data-testid={`checkbox-break-practice-${practice.domainId}`} />
          <span>{practice.displayName}{!practice.active && checked ? ' · saved selection' : ''}</span>
        </label>;
      })}
      {editing?.practiceIds.filter(id => !practices.some(practice => practice.domainId === id)).map(id =>
        <label key={id} className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={selected.has(id)} disabled={disabled}
            onChange={event => onChange(orderedSelection(selectedIds, id, event.target.checked))}
            data-testid={`checkbox-break-practice-${id}`} />
          Saved practice ({id}) is unavailable; {selected.has(id) ? 'selected and will be kept' : 'unchecked and will be removed on save'}.
        </label>)}
      {!practices.some(practice => practice.active) && !editing &&
        <p className="text-sm text-muted-foreground">No active personal practices are available.</p>}
    </fieldset>
    <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="text-break-practice-count">
      Selected: {selectedIds.length} {selectedIds.length === 1 ? "practice" : "practices"} (limit 100).
    </p>
    {selectedIds.length > 100 && <p role="alert" data-testid="alert-break-practice-limit">
      Choose which 100 or fewer practices to keep. This selection has not been trimmed.
    </p>}
    <p className="text-xs text-muted-foreground">Select at least one. Saved selections above the limit remain intact until you deliberately save a new selection.</p>
  </div>;
}

function hasUnsupportedNewPrecision(value: string): boolean {
  return (value.match(/\.(\d+)$/)?.[1].length ?? 0) > 3;
}

function samePracticeSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id));
}

function matchesUncertainCreate(saved: PersonalDeviation, draft: PersonalDeviationCreate): boolean {
  return saved.scope === 'selected' && saved.type === draft.type && saved.reason === draft.reason &&
    sameInstant(saved.startAt, draft.startAt) &&
    (saved.endAt === null ? draft.endAt === null : draft.endAt !== null && sameInstant(saved.endAt, draft.endAt)) &&
    samePracticeSet(saved.practiceIds, draft.practiceIds);
}

/** Signed-in personal break editor. The legacy deviation form above remains unchanged. */
export function PersonalDeviationForm({ open, onOpenChange, ownerId, timezone, practices, editing, onSubmit,
  onReloadAfterUncertainCreate }: PersonalDeviationFormProps) {
  const isEdit = !!editing;
  const [selectedIds, setSelectedIds] = useState<string[]>(() => editing?.practiceIds.slice() ?? []);
  const [reason, setReason] = useState(() => editing?.reason ?? '');
  const [changeReason, setChangeReason] = useState('');
  const [startLocal, setStartLocal] = useState(() => formatBreakTime(editing?.startAt ?? new Date().toISOString(), timezone));
  const [endLocal, setEndLocal] = useState(() => editing?.endAt ? formatBreakTime(editing.endAt, timezone) : '');
  const [startDirty, setStartDirty] = useState(false);
  const [endDirty, setEndDirty] = useState(false);
  const [startOccurrence, setStartOccurrence] = useState<number | null>(() => editing ? occurrenceForInstant(editing.startAt, timezone) : null);
  const [endOccurrence, setEndOccurrence] = useState<number | null>(() => editing?.endAt ? occurrenceForInstant(editing.endAt, timezone) : null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertainCreate, setUncertainCreate] = useState<PersonalDeviationCreate | null>(null);
  const [matchingSaved, setMatchingSaved] = useState<PersonalDeviation | null>(null);
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);
  const [reloadSaving, setReloadSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const now = new Date().toISOString();
    setSelectedIds(editing?.practiceIds.slice() ?? []);
    setReason(editing?.reason ?? '');
    setChangeReason('');
    setStartLocal(formatBreakTime(editing?.startAt ?? now, timezone));
    setEndLocal(editing?.endAt ? formatBreakTime(editing.endAt, timezone) : '');
    setStartDirty(false);
    setEndDirty(false);
    setStartOccurrence(editing ? occurrenceForInstant(editing.startAt, timezone) : null);
    setEndOccurrence(editing?.endAt ? occurrenceForInstant(editing.endAt, timezone) : null);
    setError(null);
    setUncertainCreate(null);
    setMatchingSaved(null);
    setReloadMessage(null);
  }, [open, editing?.deviationId, timezone]);

  if (!open || !isActivityOwner(ownerId)) return null;
  const startCandidates = wallTimeCandidates(startLocal, timezone);
  const endCandidates = endLocal ? wallTimeCandidates(endLocal, timezone) : [];
  const startInstant = resolveBreakTime(startLocal, timezone, startOccurrence, isEdit ? editing?.startAt ?? null : null, startDirty);
  const endInstant = !endLocal ? null :
    resolveBreakTime(endLocal, timezone, endOccurrence, isEdit ? editing?.endAt ?? null : null, endDirty);
  const tooManySavedPractices = !!editing && editing.practiceIds.length > 100;
  const tooManySelected = selectedIds.length > 100;
  const retroactive = startDirty && !!startInstant && Date.parse(startInstant) < Date.now();
  const locked = submitting || !!uncertainCreate;

  const handleSubmit = async () => {
    if (submitting || uncertainCreate || !isActivityOwner(ownerId)) return;
    setError(null);
    if (!reason.trim()) { setError('A break reason is required.'); return; }
    if (reason.trim().length > 500 || !changeReason.trim() || changeReason.trim().length > 500) {
      setError('Enter a break reason and a separate change explanation (up to 500 characters each).'); return;
    }
    if (selectedIds.length === 0) { setError('Select at least one personal practice.'); return; }
    if (tooManySelected) { setError('Choose no more than 100 practices. No saved selection will be removed automatically.'); return; }
    if (!startLocal || !startInstant) { setError('Choose a valid start time in your saved timezone.'); return; }
    if (endLocal && !endInstant) { setError('Choose a valid end time in your saved timezone.'); return; }
    if (isEdit && editing?.endedAt && compareBreakInstants(startInstant, editing.endedAt) !== -1) {
      setError('Start time must be before the break’s recorded actual end.');
      return;
    }
    if (endInstant && compareBreakInstants(endInstant, startInstant) !== 1) {
      setError('End time must be later than start time.'); return;
    }
    if (!isEdit && (hasUnsupportedNewPrecision(startLocal) || hasUnsupportedNewPrecision(endLocal))) {
      setError('New breaks support millisecond precision. Existing finer saved times are preserved when left unchanged.'); return;
    }
    setSubmitting(true);
    let attemptedCreate: PersonalDeviationCreate | null = null;
    try {
      const input: PersonalDeviationCreate | PersonalDeviationEdit = isEdit ? {
        startAt: startInstant,
        endAt: endInstant,
        reason: reason.trim(),
        changeReason: changeReason.trim(),
        practiceIds: selectedIds,
      } : {
        startAt: startInstant,
        endAt: endInstant,
        reason: reason.trim(),
        changeReason: changeReason.trim(),
        practiceIds: selectedIds,
        type: 'stitch' as const,
      };
      if (!isEdit) attemptedCreate = input as PersonalDeviationCreate;
      const saved = await onSubmit(input);
      if (!isActivityOwner(ownerId)) return;
      if (!saved) {
        if (!isEdit) {
          setUncertainCreate(input as PersonalDeviationCreate);
          setError('The create request was not confirmed. Your draft is preserved; reload saved breaks before another attempt.');
        } else setError('The save was not confirmed. Your entries are still here; refresh the saved breaks before trying again.');
        return;
      }
      onOpenChange(false);
    } catch {
      if (!isActivityOwner(ownerId)) return;
      if (attemptedCreate) setUncertainCreate(attemptedCreate);
      setError(isEdit
        ? 'The break could not be confirmed. Your entries are still here; refresh saved breaks before trying again.'
        : 'The create request was not confirmed. Your draft is preserved; reload saved breaks before another attempt.');
    } finally {
      setSubmitting(false);
    }
  };

  const reloadAfterUncertainCreate = async () => {
    if (!uncertainCreate || !onReloadAfterUncertainCreate || reloadSaving || !isActivityOwner(ownerId)) return;
    setReloadSaving(true);
    setReloadMessage(null);
    setMatchingSaved(null);
    try {
      const rows = await onReloadAfterUncertainCreate();
      if (!isActivityOwner(ownerId)) return;
      const matching = rows.find(row => matchesUncertainCreate(row, uncertainCreate));
      if (matching) {
        setMatchingSaved(matching);
        setReloadMessage('A matching break is in the refreshed saved list. Review it before taking any further action.');
        setError(null);
      } else {
        setUncertainCreate(null);
        setError(null);
        setReloadMessage('Saved breaks were reloaded; no exact match was found. Your draft is preserved and can be submitted again.');
      }
    } catch {
      if (isActivityOwner(ownerId)) setReloadMessage('Saved breaks could not be reloaded. Your draft is preserved and resubmission remains blocked.');
    } finally {
      setReloadSaving(false);
    }
  };

  const exactTimeChoices = (label: string, candidates: ReturnType<typeof wallTimeCandidates>, value: number | null,
    setValue: (index: number) => void, name: string) => candidates.length > 1 ? <fieldset className="space-y-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">This time occurs twice in {timezone}. Choose one.</legend>
      {candidates.map((candidate, index) => <label key={candidate.instant} className="flex items-center gap-2 text-sm">
        <input type="radio" name={name} value={index} checked={value === index} onChange={() => setValue(index)} />
        {label}: {candidate.label}
      </label>)}
    </fieldset> : null;

  return <Dialog open={open} onOpenChange={value => !submitting && (!uncertainCreate || !!matchingSaved) && onOpenChange(value)}>
    <DialogContent data-testid="dialog-personal-break-form">
      <DialogHeader>
        <DialogTitle>{isEdit ? 'Edit personal break' : 'Record a personal break'}</DialogTitle>
        <DialogDescription>Choose your practices and exact times in your saved timezone, {timezone}. Breaks may overlap.</DialogDescription>
      </DialogHeader>
      <PersonalDeviationPracticePicker practices={practices} selectedIds={selectedIds}
        onChange={setSelectedIds} editing={editing} disabled={locked} />
      {tooManySavedPractices && <p role="status">This break has {editing.practiceIds.length} saved practices. They are all kept selected. Remove selections intentionally to edit; none will be trimmed automatically.</p>}
      <div className="space-y-2">
        <Label htmlFor="personal-break-reason">Reason for this break</Label>
        <Textarea id="personal-break-reason" value={reason} onChange={event => setReason(event.target.value)}
          maxLength={500} required rows={3} disabled={locked} data-testid="input-personal-break-reason" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="personal-break-change-reason">{isEdit ? 'Why are you changing this break?' : 'Why are you recording this break?'}</Label>
        <Textarea id="personal-break-change-reason" value={changeReason} onChange={event => setChangeReason(event.target.value)}
          maxLength={500} required rows={2} disabled={locked} data-testid="input-personal-break-change-reason" />
        <p className="text-xs text-muted-foreground">This explanation is stored in the break's audit history, separately from its reason.</p>
      </div>
      <div className="grid grid-cols-1 gap-3">
        <div className="space-y-2">
          <Label htmlFor="personal-break-start">Start in {timezone}</Label>
          <Input id="personal-break-start" type="datetime-local" step="0.001" value={browserDateTimeValue(startLocal)}
            disabled={locked} onChange={event => { setStartDirty(true); setStartOccurrence(null); setStartLocal(event.target.value); }}
            data-testid="input-personal-break-start" />
          {isEdit && !startDirty && editing && <p className="text-xs font-mono text-muted-foreground"
            data-testid="personal-break-start-exact-value">Saved exact time: {startLocal} ({timezone})</p>}
          <p className="text-xs text-muted-foreground">Saved fractional seconds stay exact unless you change this field.</p>
          {exactTimeChoices('Start', startCandidates, startOccurrence, index => { setStartDirty(true); setStartOccurrence(index); }, 'personal-break-start-occurrence')}
          {startLocal && !startCandidates.length && <p role="alert">This local time does not exist in {timezone}. Choose another time.</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="personal-break-end">End (optional) in {timezone}</Label>
          <Input id="personal-break-end" type="datetime-local" step="0.001" value={browserDateTimeValue(endLocal)}
            disabled={locked} onChange={event => { setEndDirty(true); setEndOccurrence(null); setEndLocal(event.target.value); }}
            data-testid="input-personal-break-end" />
          {isEdit && !endDirty && editing?.endAt && <p className="text-xs font-mono text-muted-foreground"
            data-testid="personal-break-end-exact-value">Saved exact time: {endLocal} ({timezone})</p>}
          <p className="text-xs text-muted-foreground">Saved fractional seconds stay exact unless you change this field.</p>
          {exactTimeChoices('End', endCandidates, endOccurrence, index => { setEndDirty(true); setEndOccurrence(index); }, 'personal-break-end-occurrence')}
          {endLocal && !endCandidates.length && <p role="alert">This local time does not exist in {timezone}. Choose another time.</p>}
        </div>
      </div>
      {retroactive && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="personal-break-retroactive">
        Retroactive entry: this break starts in the past.
      </p>}
      {error && <p role="alert" data-testid="personal-break-form-error">{error}</p>}
      {uncertainCreate && <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="personal-break-uncertain-create">
        <p>The create request may have saved, but its response was not confirmed. Your draft is preserved and another submission is blocked until saved breaks are reloaded.</p>
        {reloadMessage && <p role="status" className="mt-2" data-testid="personal-break-reload-status">{reloadMessage}</p>}
        {matchingSaved && <div className="mt-2 rounded border p-2">
          <p className="font-medium">Possible saved match: {matchingSaved.reason}</p>
          <p>{formatBreakTime(matchingSaved.startAt, timezone)} – {matchingSaved.endAt ? formatBreakTime(matchingSaved.endAt, timezone) : 'No planned end'} ({timezone})</p>
          <p>{matchingSaved.practiceIds.map(id => practices.find(practice => practice.domainId === id)?.displayName ?? `Saved practice (${id})`).join(', ')}</p>
          <Button type="button" className="mt-2" onClick={() => onOpenChange(false)} data-testid="button-close-matched-break">
            Close and review saved break
          </Button>
        </div>}
        {!matchingSaved && <Button type="button" variant="outline" className="mt-2" disabled={reloadSaving || !onReloadAfterUncertainCreate}
          onClick={() => void reloadAfterUncertainCreate()} data-testid="button-reload-uncertain-breaks">
          {reloadSaving ? 'Reloading…' : 'Reload saved breaks before retrying'}
        </Button>}
      </div>}
      {!uncertainCreate && reloadMessage && <p role="status" data-testid="personal-break-reload-status">{reloadMessage}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={submitting || (!!uncertainCreate && !matchingSaved)}
          onClick={() => onOpenChange(false)}>{matchingSaved ? 'Close form' : 'Cancel'}</Button>
        <Button disabled={submitting || !!uncertainCreate || tooManySelected || !isActivityOwner(ownerId)}
          onClick={() => void handleSubmit()} data-testid="button-save-personal-break">
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Save break'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
