import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Check, Clock, CalendarClock, AlertTriangle, TrendingDown, Repeat, Undo2, Pencil } from 'lucide-react';
import { useAppStore, Domain, DOMAIN_POLICY, type Session } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';
import type { AnomalyCheckResponse } from '@shared/schema';

type Stage = 'idle' | 'anomaly' | 'below-floor' | 'frequency' | 'saving' | 'saved';

const POST_SAVE_TOAST_MS = 8000;

// Local-time string accepted by <input type="datetime-local"> (not UTC).
function formatLocalDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Falls back to "now" for invalid input and clamps future timestamps;
// the input's max attribute is UX-only.
function resolveSessionTimestamp(local: string): Date {
  const now = new Date();
  if (!local) return now;
  const parsed = new Date(local);
  if (Number.isNaN(parsed.getTime())) return now;
  if (parsed.getTime() > now.getTime()) return now;
  return parsed;
}

export default function LogSession() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const initialDomain = (searchParams.get('domain') as Domain) || 'martial-arts';
  const initialEditId = searchParams.get('edit');

  const [domain, setDomain] = useState<Domain>(initialDomain);
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [sessionDate, setSessionDate] = useState<string>(() => formatLocalDateTime(new Date()));
  // wouter's location hook tracks pathname only, so the toast Edit action
  // flips this in-place rather than relying on a query-string remount.
  const [editingSessionId, setEditingSessionId] = useState<string | null>(initialEditId);

  const [anomalyResult, setAnomalyResult] = useState<AnomalyCheckResponse | null>(null);
  const [anomalyNote, setAnomalyNote] = useState('');

  const savedSessionRef = useRef<Session | null>(null);
  const [toastDismissAt, setToastDismissAt] = useState<number | null>(null);
  const [toastNow, setToastNow] = useState<number>(() => Date.now());

  const addSession = useAppStore(state => state.addSession);
  const updateSession = useAppStore(state => state.updateSession);
  const deleteSession = useAppStore(state => state.deleteSession);
  const sessions = useAppStore(state => state.sessions);
  const fetchSessions = useAppStore(state => state.fetchSessions);

  // Edit-mode pre-population: re-runs once sessions arrive on cold deep-link.
  useEffect(() => {
    if (!initialEditId) return;
    const target = sessions.find(s => s.id === initialEditId);
    if (target) {
      setDomain(target.domain as Domain);
      setDuration(target.durationMinutes);
      setSessionDate(formatLocalDateTime(new Date(target.timestamp)));
      setNotes(target.notes ?? '');
    } else if (sessions.length === 0) {
      void fetchSessions();
    }
  }, [initialEditId, sessions, fetchSessions]);

  // Decisions accumulated across modal prompts; passed explicitly to avoid
  // stale-closure reads when handlers re-invoke runSaveFlow.
  interface SaveDecisions {
    anomaly: { isAnomaly: boolean; note: string | null } | null;
    belowFloorAck: boolean;
    frequencyAck: boolean;
  }

  const runSaveFlow = async (decisions: SaveDecisions) => {
    setStage('saving');

    // Step 1: anomaly check (fail-open on network/server error).
    let anomalyDecision = decisions.anomaly;
    if (!anomalyDecision) {
      try {
        const res = await fetch('/api/sessions/anomaly-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain, durationMinutes: duration }),
        });
        if (res.ok) {
          const result: AnomalyCheckResponse = await res.json();
          if (result.isAnomaly) {
            setAnomalyResult(result);
            setAnomalyNote('');
            setStage('anomaly');
            return;
          }
        } else {
          console.warn('anomaly-check returned non-OK status; proceeding without anomaly flag');
        }
        anomalyDecision = { isAnomaly: false, note: null };
      } catch (err) {
        console.warn('anomaly-check failed; proceeding without anomaly flag', err);
        anomalyDecision = { isAnomaly: false, note: null };
      }
    }

    // Step 2: below-floor advisory.
    const floor = DOMAIN_POLICY[domain].sessionFloor;
    if (duration < floor && !decisions.belowFloorAck) {
      pendingDecisionsRef.current = { ...decisions, anomaly: anomalyDecision };
      setStage('below-floor');
      return;
    }

    // Step 3: frequency advisory, keyed off the selected date.
    if (!decisions.frequencyAck) {
      const selected = new Date(sessionDate);
      const selectedKey = `${selected.getFullYear()}-${selected.getMonth()}-${selected.getDate()}`;
      const hasOnSelectedDay = sessions.some((s) => {
        if (s.deletedAt) return false;
        if (s.domain !== domain) return false;
        const t = new Date(s.timestamp);
        const k = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
        return k === selectedKey;
      });
      if (hasOnSelectedDay) {
        pendingDecisionsRef.current = { ...decisions, anomaly: anomalyDecision };
        setStage('frequency');
        return;
      }
    }

    const isoTimestamp = resolveSessionTimestamp(sessionDate).toISOString();
    const trimmedNotes = notes.trim();

    if (editingSessionId) {
      const result = await updateSession(
        editingSessionId,
        {
          domain,
          durationMinutes: duration,
          timestamp: isoTimestamp,
          notes: trimmedNotes || null,
        },
        'Post-save edit',
      );
      if (result) setLocation('/');
      else setStage('idle');
      return;
    }

    const saved = await addSession({
      domain,
      durationMinutes: duration,
      timestamp: isoTimestamp,
      notes: trimmedNotes || undefined,
      isAnomaly: anomalyDecision.isAnomaly,
      anomalyNote: anomalyDecision.isAnomaly ? anomalyDecision.note : null,
    });

    if (saved) {
      savedSessionRef.current = saved;
      setToastDismissAt(Date.now() + POST_SAVE_TOAST_MS);
      setToastNow(Date.now());
      setStage('saved');
    } else {
      // No id to Undo against → skip the toast.
      setLocation('/');
    }
  };

  const pendingDecisionsRef = useRef<SaveDecisions>({
    anomaly: null,
    belowFloorAck: false,
    frequencyAck: false,
  });

  const handleSave = () => {
    pendingDecisionsRef.current = {
      anomaly: null,
      belowFloorAck: false,
      frequencyAck: false,
    };
    void runSaveFlow(pendingDecisionsRef.current);
  };

  const onAnomalyConfirm = () => {
    const trimmed = anomalyNote.trim();
    if (!trimmed) return;
    const next: SaveDecisions = {
      ...pendingDecisionsRef.current,
      anomaly: { isAnomaly: true, note: trimmed },
    };
    pendingDecisionsRef.current = next;
    setAnomalyResult(null);
    void runSaveFlow(next);
  };

  const onAnomalyCancel = () => {
    setStage('idle');
    setAnomalyResult(null);
    setAnomalyNote('');
  };

  const onBelowFloorConfirm = () => {
    const next: SaveDecisions = {
      ...pendingDecisionsRef.current,
      belowFloorAck: true,
    };
    pendingDecisionsRef.current = next;
    void runSaveFlow(next);
  };

  const onBelowFloorCancel = () => {
    setStage('idle');
  };

  const onFrequencyConfirm = () => {
    const next: SaveDecisions = {
      ...pendingDecisionsRef.current,
      frequencyAck: true,
    };
    pendingDecisionsRef.current = next;
    void runSaveFlow(next);
  };

  const onFrequencyCancel = () => {
    setStage('idle');
  };

  // Auto-dismiss the post-save toast so the user isn't trapped if they walk away.
  useEffect(() => {
    if (stage !== 'saved') return;
    const t = window.setTimeout(() => {
      savedSessionRef.current = null;
      setLocation('/');
    }, POST_SAVE_TOAST_MS);
    return () => window.clearTimeout(t);
  }, [stage, setLocation]);

  // Tick toastNow every ~100ms while the toast is up so PostSaveToast's
  // remaining-time calc actually re-renders. The setTimeout above is the
  // source of truth for the auto-dismiss itself.
  useEffect(() => {
    if (stage !== 'saved' || toastDismissAt === null) return;
    const i = window.setInterval(() => {
      const now = Date.now();
      setToastNow(now);
      if (now >= toastDismissAt) window.clearInterval(i);
    }, 100);
    return () => window.clearInterval(i);
  }, [stage, toastDismissAt]);

  const onPostSaveUndo = async () => {
    const saved = savedSessionRef.current;
    if (!saved) {
      setLocation('/');
      return;
    }
    savedSessionRef.current = null;
    await deleteSession(saved.id);
    setLocation('/');
  };

  const onPostSaveEdit = () => {
    const saved = savedSessionRef.current;
    if (!saved) {
      setLocation('/');
      return;
    }
    savedSessionRef.current = null;
    // Flip into edit mode in-place; URL kept in sync via replaceState since
    // wouter doesn't remount on a query-only change.
    setDomain(saved.domain as Domain);
    setDuration(saved.durationMinutes);
    setSessionDate(formatLocalDateTime(new Date(saved.timestamp)));
    setNotes(saved.notes ?? '');
    setEditingSessionId(saved.id);
    setToastDismissAt(null);
    setStage('idle');
    window.history.replaceState(null, '', `/log?edit=${saved.id}`);
  };

  const onPostSaveDismiss = () => {
    savedSessionRef.current = null;
    setLocation('/');
  };

  const setDomainAndReset = (d: Domain) => {
    setDomain(d);
  };

  const setDurationAndReset = (m: number) => {
    setDuration(m);
  };

  const domains: { id: Domain; label: string }[] = [
    { id: 'martial-arts', label: 'Martial Arts' },
    { id: 'meditation', label: 'Meditation' },
    { id: 'fitness', label: 'Fitness' },
    { id: 'music', label: 'Music' }
  ];

  const durations = [5, 10, 15, 20, 30];
  const saving = stage === 'saving';
  // Lock the form during the post-save toast window to prevent a second save.
  const formDisabled = saving || stage === 'saved';
  const floor = DOMAIN_POLICY[domain].sessionFloor;
  const maxDateTime = formatLocalDateTime(new Date());

  return (
    <div className="min-h-screen bg-background text-foreground pb-24 font-sans transition-colors duration-300">
      <header className="px-4 py-5 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-md border-b border-border/40 z-10">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setLocation('/')}
            className="p-2 -ml-2 rounded-full active:scale-95 hover:bg-accent/50 text-muted-foreground transition-all"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h1 className="text-xl font-bold tracking-tight">Log Session</h1>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-8">
        {/* Domain Selection */}
        <section className="space-y-3">
          <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Domain</label>
          <div className="grid grid-cols-2 gap-3">
            {domains.map(d => (
              <button
                key={d.id}
                onClick={() => setDomainAndReset(d.id)}
                disabled={formDisabled}
                className={`p-4 rounded-xl border text-left transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed ${
                  domain === d.id
                    ? `border-primary bg-primary/5 text-primary ring-1 ring-primary/20`
                    : 'border-border/50 bg-card text-muted-foreground hover:bg-accent/50'
                }`}
                data-testid={`button-domain-${d.id}`}
              >
                <div className="font-semibold">{d.label}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Session date/time — D1.1 (SOMR-304) backdating affordance */}
        <section className="space-y-3">
          <label
            htmlFor="input-session-date"
            className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2"
          >
            <CalendarClock className="w-4 h-4" />
            Session date / time
          </label>
          <input
            id="input-session-date"
            type="datetime-local"
            value={sessionDate}
            max={maxDateTime}
            disabled={formDisabled}
            onChange={(e) => setSessionDate(e.target.value)}
            className="w-full bg-card border border-border/50 rounded-2xl p-4 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
            data-testid="input-session-date"
          />
          <p className="text-xs text-muted-foreground/80">
            Defaults to now. Pick an earlier time to backdate a session you forgot to log.
          </p>
        </section>

        {/* Duration Selection */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Duration</label>
            <div className="flex items-center gap-1.5 text-primary text-sm font-mono font-bold">
              <Clock className="w-4 h-4" />
              {duration} min
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {durations.map(m => (
              <button
                key={m}
                onClick={() => setDurationAndReset(m)}
                disabled={formDisabled}
                className={`px-4 py-2.5 rounded-full text-sm font-medium transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed ${
                  duration === m
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-card border border-border/50 text-foreground hover:bg-accent/50'
                }`}
                data-testid={`button-duration-${m}`}
              >
                {m}m
              </button>
            ))}
          </div>

          <input
            type="range"
            min="5"
            max="240"
            step="5"
            value={duration}
            disabled={formDisabled}
            onChange={(e) => setDurationAndReset(Number(e.target.value))}
            className="w-full mt-6 accent-primary h-2 bg-muted rounded-lg appearance-none cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            data-testid="input-duration-slider"
          />
        </section>

        {/* Notes */}
        <section className="space-y-3">
          <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Notes (Optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={formDisabled}
            placeholder="How did it go?"
            className="w-full bg-card border border-border/50 rounded-2xl p-4 min-h-[120px] resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground placeholder:text-muted-foreground/50 transition-all shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
            data-testid="input-notes"
          />
        </section>
      </main>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pb-8 pt-12 pointer-events-none">
        <button
          onClick={handleSave}
          disabled={formDisabled}
          className="w-full h-14 rounded-2xl bg-primary text-primary-foreground font-semibold text-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-transform shadow-lg shadow-primary/20 pointer-events-auto disabled:opacity-60 disabled:cursor-not-allowed"
          data-testid="button-save-session"
        >
          <Check className="w-5 h-5" />
          {saving ? 'Saving…' : 'Save Session'}
        </button>
      </div>

      {/* ── Anomaly modal ─────────────────────────────────────────────── */}
      {stage === 'anomaly' && anomalyResult && (
        <PromptModal
          icon={<AlertTriangle className="w-6 h-6 text-status-advisory" />}
          tone="advisory"
          title="Unusual session length"
          testId="modal-anomaly"
          body={
            <>
              <p>
                <span className="font-mono font-bold">{duration} min</span> is well outside your
                typical {domain.replace('-', ' ')} session length
                {' '}(<span className="font-mono">avg {anomalyResult.mean} min</span>,
                {' '}<span className="font-mono">σ {anomalyResult.stdDev} min</span>,
                {' '}z = <span className="font-mono">{anomalyResult.zScore}</span>).
              </p>
              <p className="mt-3">Add a note to confirm this session is intentional:</p>
              <textarea
                value={anomalyNote}
                onChange={(e) => setAnomalyNote(e.target.value)}
                placeholder="What made today different?"
                className="w-full mt-3 bg-background border border-border/60 rounded-xl p-3 min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-status-advisory/40 text-foreground placeholder:text-muted-foreground/50"
                data-testid="input-anomaly-note"
                autoFocus
              />
            </>
          }
          confirmLabel="Confirm & Save"
          confirmDisabled={!anomalyNote.trim()}
          onConfirm={onAnomalyConfirm}
          onCancel={onAnomalyCancel}
        />
      )}

      {/* ── Below-floor advisory ──────────────────────────────────────── */}
      {stage === 'below-floor' && (
        <PromptModal
          icon={<TrendingDown className="w-6 h-6 text-status-degraded" />}
          tone="degraded"
          title="Below session floor"
          testId="modal-below-floor"
          body={
            <p>
              This session is <span className="font-mono font-bold">{duration} min</span>, under
              the {floor}-minute floor for {domain.replace('-', ' ')}. It still counts toward total
              minutes but won't count as a qualifying day. Save anyway?
            </p>
          }
          confirmLabel="Save anyway"
          onConfirm={onBelowFloorConfirm}
          onCancel={onBelowFloorCancel}
        />
      )}

      {/* ── Frequency advisory ────────────────────────────────────────── */}
      {stage === 'frequency' && (
        <PromptModal
          icon={<Repeat className="w-6 h-6 text-status-advisory" />}
          tone="advisory"
          title="Already logged on this date"
          testId="modal-frequency"
          body={
            <p>
              You've already logged a {domain.replace('-', ' ')} session on this date. Logging
              another is fine — just confirming this isn't a duplicate.
            </p>
          }
          confirmLabel="Save anyway"
          onConfirm={onFrequencyConfirm}
          onCancel={onFrequencyCancel}
        />
      )}

      {stage === 'saved' && toastDismissAt !== null && (
        <PostSaveToast
          dismissAt={toastDismissAt}
          now={toastNow}
          totalMs={POST_SAVE_TOAST_MS}
          onUndo={onPostSaveUndo}
          onEdit={onPostSaveEdit}
          onDismiss={onPostSaveDismiss}
        />
      )}
    </div>
  );
}

interface PostSaveToastProps {
  dismissAt: number;
  now: number;
  totalMs: number;
  onUndo: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}

function PostSaveToast({ dismissAt, now, totalMs, onUndo, onEdit, onDismiss }: PostSaveToastProps) {
  const remaining = Math.max(0, dismissAt - now);
  const pct = Math.max(0, Math.min(100, (remaining / totalMs) * 100));
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 p-4 pb-6 pointer-events-none"
      role="status"
      aria-live="polite"
      data-testid="toast-post-save"
    >
      <div className="mx-auto max-w-md bg-card border border-border/60 rounded-2xl shadow-2xl overflow-hidden pointer-events-auto">
        <div className="flex items-center gap-3 p-4">
          <div className="shrink-0 w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
            <Check className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-foreground tracking-tight">Session saved</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Tap Undo or Edit if you logged the wrong thing.
            </p>
          </div>
          <button
            type="button"
            onClick={onUndo}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 h-9 rounded-xl border border-border/60 text-foreground text-sm font-medium hover:bg-accent/50 active:scale-95 transition-all"
            data-testid="button-toast-undo"
          >
            <Undo2 className="w-4 h-4" />
            Undo
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 h-9 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 active:scale-95 transition-all"
            data-testid="button-toast-edit"
          >
            <Pencil className="w-4 h-4" />
            Edit
          </button>
        </div>
        {/* Countdown bar — width tracks remaining time. The transition
            smooths the per-tick jumps from the parent's interval. */}
        <div className="h-1 bg-muted/40">
          <div
            className="h-full bg-primary transition-[width] duration-100 ease-linear"
            style={{ width: `${pct}%` }}
            data-testid="toast-progress"
          />
        </div>
        {/* Hidden dismiss affordance — reserved for keyboard / a11y; the
            visible Undo and Edit are the primary actions. */}
        <button
          type="button"
          onClick={onDismiss}
          className="sr-only"
          aria-label="Dismiss save confirmation"
          data-testid="button-toast-dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ─── Modal component ────────────────────────────────────────────────────────

interface PromptModalProps {
  icon: React.ReactNode;
  tone: 'advisory' | 'degraded';
  title: string;
  testId: string;
  body: React.ReactNode;
  confirmLabel: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function PromptModal({
  icon,
  tone,
  title,
  testId,
  body,
  confirmLabel,
  confirmDisabled,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const ringClass =
    tone === 'advisory' ? 'ring-status-advisory/30' : 'ring-status-degraded/30';
  const confirmClass =
    tone === 'advisory'
      ? 'bg-status-advisory text-background hover:bg-status-advisory/90'
      : 'bg-status-degraded text-background hover:bg-status-degraded/90';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      data-testid={testId}
    >
      <div
        className={`w-full max-w-md bg-card border border-border/60 rounded-3xl shadow-2xl ring-1 ${ringClass} p-5`}
      >
        <div className="flex items-start gap-3">
          <div className="shrink-0 mt-0.5">{icon}</div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-bold text-foreground tracking-tight">{title}</h2>
            <div className="mt-2 text-sm text-muted-foreground leading-relaxed">{body}</div>
          </div>
        </div>
        <div className="mt-5 flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-4 h-11 rounded-xl border border-border/60 text-foreground font-medium hover:bg-accent/40 active:scale-95 transition-all"
            data-testid={`${testId}-cancel`}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={`px-4 h-11 rounded-xl font-semibold active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${confirmClass}`}
            data-testid={`${testId}-confirm`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
