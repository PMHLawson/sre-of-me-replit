import { useEffect, useState } from 'react';
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
import type { Domain, Deviation, DeviationDraft, DeviationPatch } from '@/store';

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

export function DeviationForm({ open, onOpenChange, editing, onSubmit }: DeviationFormProps) {
  const isEdit = !!editing;
  const [domain, setDomain] = useState<Domain>('fitness');
  const [reason, setReason] = useState('');
  const [startLocal, setStartLocal] = useState(toLocalInputValue(new Date().toISOString()));
  const [endLocal, setEndLocal] = useState('');
  const [excludeFromComposite, setExcludeFromComposite] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setDomain(editing.domain as Domain);
      setReason(editing.reason);
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
    setError(null);
  }, [open, editing]);

  const handleSubmit = async () => {
    setError(null);
    if (!reason.trim()) {
      setError('Reason is required.');
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
          reason: reason.trim(),
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
          reason: reason.trim(),
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
              onChange={(e) => setReason(e.target.value)}
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
            disabled={submitting}
            data-testid="button-deviation-submit"
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Declare deviation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
