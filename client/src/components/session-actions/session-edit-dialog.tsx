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
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Session, SessionPatch, Domain } from '@/store';

const DOMAIN_LABEL: Record<Domain, string> = {
  'martial-arts': 'Martial Arts',
  meditation: 'Meditation',
  fitness: 'Fitness',
  music: 'Music',
};

const DOMAINS: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];

/**
 * Mirrors the timezone marshalling used by the deviation form so the local
 * datetime-local input round-trips cleanly through z.string().datetime({ offset: true }).
 */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(local: string): string {
  return new Date(local).toISOString();
}

interface SessionEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Session to edit. Form pre-fills from these values. */
  session: Session | null;
  /** Called with the patch payload (includes the required reason note). */
  onSubmit: (patch: SessionPatch) => Promise<Session | null>;
}

export function SessionEditDialog({ open, onOpenChange, session, onSubmit }: SessionEditDialogProps) {
  const [domain, setDomain] = useState<Domain>('fitness');
  const [duration, setDuration] = useState('30');
  const [timestampLocal, setTimestampLocal] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !session) return;
    setDomain(session.domain);
    setDuration(String(session.durationMinutes));
    setTimestampLocal(toLocalInputValue(session.timestamp));
    setNotes(session.notes ?? '');
    setReason('');
    setError(null);
  }, [open, session]);

  const handleSubmit = async () => {
    if (!session) return;
    setError(null);
    if (!reason.trim()) {
      setError('Reason for edit is required.');
      return;
    }
    const durationNum = Number(duration);
    if (!Number.isFinite(durationNum) || durationNum <= 0 || !Number.isInteger(durationNum)) {
      setError('Duration must be a positive whole number of minutes.');
      return;
    }
    if (!timestampLocal) {
      setError('Timestamp is required.');
      return;
    }

    const patch: SessionPatch = {
      domain,
      durationMinutes: durationNum,
      timestamp: fromLocalInputValue(timestampLocal),
      notes: notes.trim() ? notes.trim() : null,
      reason: reason.trim(),
    };

    setSubmitting(true);
    try {
      const result = await onSubmit(patch);
      if (!result) {
        setError('Could not save changes. Please try again.');
        return;
      }
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-session-edit">
        <DialogHeader>
          <DialogTitle>Edit Session</DialogTitle>
          <DialogDescription>
            Correct a logged session. A short reason note is required so the change is captured in the edit history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="session-edit-domain">Domain</Label>
            <Select value={domain} onValueChange={(v) => setDomain(v as Domain)}>
              <SelectTrigger id="session-edit-domain" data-testid="select-session-edit-domain">
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="session-edit-duration">Duration (minutes)</Label>
              <Input
                id="session-edit-duration"
                type="number"
                min={1}
                step={1}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                data-testid="input-session-edit-duration"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="session-edit-timestamp">Timestamp</Label>
              <Input
                id="session-edit-timestamp"
                type="datetime-local"
                value={timestampLocal}
                onChange={(e) => setTimestampLocal(e.target.value)}
                data-testid="input-session-edit-timestamp"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="session-edit-notes">Notes (optional)</Label>
            <Textarea
              id="session-edit-notes"
              placeholder="What did you do?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              data-testid="input-session-edit-notes"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="session-edit-reason">Reason for edit</Label>
            <Textarea
              id="session-edit-reason"
              placeholder="e.g. Logged the wrong duration; corrected from notes"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              data-testid="input-session-edit-reason"
            />
            <p className="text-xs text-muted-foreground">
              Recorded in the audit log alongside the prior values.
            </p>
          </div>

          {error && (
            <p className="text-sm text-status-critical" data-testid="text-session-edit-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="button-session-edit-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            data-testid="button-session-edit-submit"
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
