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
import { AlertTriangle } from 'lucide-react';
import type { AnomalyCheckResponse } from '@shared/schema';
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

/** Multi-step flow within the dialog. */
type Stage = 'idle' | 'checking' | 'anomaly' | 'saving';

interface SessionEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Session to edit. Form pre-fills from these values. */
  session: Session | null;
  /** Called with the field patch and the required audit reason. */
  onSubmit: (patch: SessionPatch, reason: string) => Promise<Session | null>;
}

export function SessionEditDialog({ open, onOpenChange, session, onSubmit }: SessionEditDialogProps) {
  const [domain, setDomain] = useState<Domain>('fitness');
  const [duration, setDuration] = useState('30');
  const [timestampLocal, setTimestampLocal] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Anomaly preflight state (C1.1 — mirrors log-session).
  const [stage, setStage] = useState<Stage>('idle');
  const [anomalyResult, setAnomalyResult] = useState<AnomalyCheckResponse | null>(null);
  const [anomalyNote, setAnomalyNote] = useState('');

  useEffect(() => {
    if (!open || !session) return;
    setDomain(session.domain);
    setDuration(String(session.durationMinutes));
    setTimestampLocal(toLocalInputValue(session.timestamp));
    setNotes(session.notes ?? '');
    setReason('');
    setError(null);
    setStage('idle');
    setAnomalyResult(null);
    setAnomalyNote('');
  }, [open, session]);

  /** Validate form fields; returns parsed durationNum or null on failure. */
  function validateForm(): number | null {
    if (!reason.trim()) { setError('Reason for edit is required.'); return null; }
    const durationNum = Number(duration);
    if (!Number.isFinite(durationNum) || durationNum <= 0 || !Number.isInteger(durationNum)) {
      setError('Duration must be a positive whole number of minutes.');
      return null;
    }
    if (!timestampLocal) { setError('Timestamp is required.'); return null; }
    return durationNum;
  }

  /** Final PATCH — called after any anomaly decision is resolved. */
  const doSubmit = async (durationNum: number, isAnomaly: boolean, anomalyNoteValue: string | null) => {
    if (!session) return;
    const patch: SessionPatch = {
      domain,
      durationMinutes: durationNum,
      timestamp: fromLocalInputValue(timestampLocal),
      notes: notes.trim() ? notes.trim() : null,
      isAnomaly,
      anomalyNote: isAnomaly ? anomalyNoteValue : null,
    };
    setStage('saving');
    try {
      const result = await onSubmit(patch, reason.trim());
      if (!result) {
        setError('Could not save changes. Please try again.');
        setStage('idle');
        return;
      }
      onOpenChange(false);
    } catch {
      setError('Could not save changes. Please try again.');
      setStage('idle');
    }
  };

  /** Primary save button handler: validate → anomaly preflight → submit. */
  const handleSubmit = async () => {
    if (!session) return;
    setError(null);
    const durationNum = validateForm();
    if (durationNum === null) return;

    setStage('checking');

    // Anomaly preflight — fail-open on network/server error (mirrors log-session).
    try {
      const res = await fetch('/api/sessions/anomaly-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, durationMinutes: durationNum }),
      });
      if (res.ok) {
        const result: AnomalyCheckResponse = await res.json();
        if (result.isAnomaly) {
          setAnomalyResult(result);
          setAnomalyNote('');
          setStage('anomaly');
          return;
        }
      }
    } catch {
      // fail-open: proceed without anomaly flag
    }

    await doSubmit(durationNum, false, null);
  };

  /** Confirm the anomaly prompt and proceed to save. */
  const handleAnomalyConfirm = async () => {
    if (!anomalyNote.trim()) return;
    const durationNum = Number(duration);
    await doSubmit(durationNum, true, anomalyNote.trim());
  };

  /** Cancel the anomaly prompt and return to the edit form. */
  const handleAnomalyCancel = () => {
    setStage('idle');
    setAnomalyResult(null);
    setAnomalyNote('');
  };

  const busy = stage === 'checking' || stage === 'saving';

  // ── Anomaly confirmation screen ───────────────────────────────────────────
  if (stage === 'anomaly' && anomalyResult) {
    const durationNum = Number(duration);
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="dialog-session-edit-anomaly">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-status-advisory" />
              Unusual session length
            </DialogTitle>
            <DialogDescription>
              This duration is outside your typical range for {domain.replace('-', ' ')}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <p className="text-sm text-foreground">
              <span className="font-mono font-bold">{durationNum} min</span> is well outside your
              typical {domain.replace('-', ' ')} session length
              {' '}(<span className="font-mono">avg {anomalyResult.mean} min</span>,
              {' '}<span className="font-mono">σ {anomalyResult.stdDev} min</span>,
              {' '}z = <span className="font-mono">{anomalyResult.zScore}</span>).
            </p>
            <p className="text-sm text-muted-foreground">Add a note to confirm this is intentional:</p>
            <div className="space-y-2">
              <Label htmlFor="session-edit-anomaly-note">Anomaly note</Label>
              <Textarea
                id="session-edit-anomaly-note"
                placeholder="What made this session different?"
                value={anomalyNote}
                onChange={(e) => setAnomalyNote(e.target.value)}
                rows={3}
                autoFocus
                data-testid="input-session-edit-anomaly-note"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={handleAnomalyCancel}
              data-testid="button-session-edit-anomaly-cancel"
            >
              Back
            </Button>
            <Button
              onClick={handleAnomalyConfirm}
              disabled={!anomalyNote.trim()}
              data-testid="button-session-edit-anomaly-confirm"
            >
              Confirm &amp; save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Normal edit form ──────────────────────────────────────────────────────
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
            disabled={busy}
            data-testid="button-session-edit-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={busy}
            data-testid="button-session-edit-submit"
          >
            {stage === 'checking' ? 'Checking…' : stage === 'saving' ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
