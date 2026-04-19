import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Check, Clock, CalendarClock, AlertTriangle, TrendingDown, Repeat, Undo2, Pencil } from 'lucide-react';
import { useAppStore, Domain, DOMAIN_POLICY, type Session } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';
import type { AnomalyCheckResponse } from '@shared/schema';

// 'saved' = D1.2 post-save toast window. While in this stage no further form
// edits are accepted; the user can Undo, Edit, or wait for auto-dismiss.
type Stage = 'idle' | 'anomaly' | 'below-floor' | 'frequency' | 'saving' | 'saved';

// D1.2 (SOMR-305) — how long the post-save toast remains on screen before
// auto-dismissing and navigating back to the dashboard.
const POST_SAVE_TOAST_MS = 8000;

/**
 * Format a Date as the local-time string a `<input type="datetime-local">`
 * accepts: `YYYY-MM-DDThh:mm`. We deliberately use local components (not
 * toISOString, which is UTC) so the picker shows the wall-clock time the
 * user is actually living in.
 */
function formatLocalDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Resolve a datetime-local string to a Date safe to pass to `.toISOString()`.
 * Empty / malformed input falls back to "now" (the picker's default), and
 * any future moment is clamped to "now" — the input's `max` attribute is
 * UX-only and can be bypassed by DOM tampering or hydration edge cases, so
 * this is the actual hard guard that backs SOMR-304's "no future timestamps"
 * acceptance criterion.
 */
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
  // D1.2 (SOMR-305): when present, the page is in edit mode and Save will
  // PATCH the existing session via the B2 correction path instead of POSTing
  // a new one. The id is captured once on mount; later URL changes are
  // ignored for stability.
  const initialEditId = searchParams.get('edit');

  const [domain, setDomain] = useState<Domain>(initialDomain);
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  // D1.1 (SOMR-304): user-selectable session timestamp for backdating.
  // Default = "now" in local time. Capped to "now" via the input's `max`
  // attribute so future dates can't be selected.
  const [sessionDate, setSessionDate] = useState<string>(() => formatLocalDateTime(new Date()));
  // D1.2 (SOMR-305): set when this page is editing an already-saved session.
  // Drives PATCH-vs-POST in runSaveFlow. Locked at mount; we never transition
  // a logging session into an edit session in-place.
  const editingSessionId = initialEditId;

  // Anomaly modal state — populated only while the anomaly modal is showing.
  const [anomalyResult, setAnomalyResult] = useState<AnomalyCheckResponse | null>(null);
  const [anomalyNote, setAnomalyNote] = useState('');

  // D1.2 (SOMR-305) — the just-saved row, kept in a ref so the post-save
  // toast and its timers don't re-render the whole form. Cleared whenever
  // the toast resolves (Undo, Edit, auto-dismiss).
  const savedSessionRef = useRef<Session | null>(null);
  // Tick the toast countdown bar by re-rendering once a frame's-worth of
  // time has elapsed. The actual auto-dismiss is driven by the timeout
  // below; this is purely visual.
  const [toastDismissAt, setToastDismissAt] = useState<number | null>(null);
  const [toastNow, setToastNow] = useState<number>(() => Date.now());

  const addSession = useAppStore(state => state.addSession);
  const updateSession = useAppStore(state => state.updateSession);
  const deleteSession = useAppStore(state => state.deleteSession);
  const sessions = useAppStore(state => state.sessions);
  const fetchSessions = useAppStore(state => state.fetchSessions);

  // ── Edit-mode pre-population (D1.2 / SOMR-305) ──────────────────────────
  // On mount with `?edit=<id>`, find the row in the store and seed every
  // field. If the sessions list isn't loaded yet (deep-link, refresh) we
  // trigger a fetch and try again once it arrives.
  useEffect(() => {
    if (!initialEditId) return;
    const target = sessions.find(s => s.id === initialEditId);
    if (target) {
      setDomain(target.domain as Domain);
      setDuration(target.durationMinutes);
      setSessionDate(formatLocalDateTime(new Date(target.timestamp)));
      setNotes(target.notes ?? '');
    } else if (sessions.length === 0) {
      // Sessions haven't loaded; kick off a fetch and let the next render
      // (when sessions populate) re-run this effect.
      void fetchSessions();
    }
    // We intentionally depend on sessions so the effect re-runs after a
    // deferred fetch resolves.
  }, [initialEditId, sessions, fetchSessions]);

  /**
   * Decisions accumulated as the user walks through each modal. Passed
   * explicitly through `runSaveFlow` so we never read stale state from a
   * captured closure (the previous setTimeout(handleSave, 0) re-entry was
   * subject to that bug). Each modal confirm handler computes the new
   * decision locally and re-invokes runSaveFlow with it.
   */
  interface SaveDecisions {
    anomaly: { isAnomaly: boolean; note: string | null } | null;
    belowFloorAck: boolean;
    frequencyAck: boolean;
  }

  const runSaveFlow = async (decisions: SaveDecisions) => {
    setStage('saving');

    // ── Step 1: anomaly check ────────────────────────────────────────────
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
          // Server returned a non-2xx — treat as fail-open (proceed without
          // flagging) so a transient API problem doesn't block logging.
          // The session is saved as non-anomalous; users can still review
          // it later. Logged for observability.
          console.warn('anomaly-check returned non-OK status; proceeding without anomaly flag');
        }
        anomalyDecision = { isAnomaly: false, note: null };
      } catch (err) {
        // Network error — same fail-open policy. Logging > prompting wins.
        console.warn('anomaly-check failed; proceeding without anomaly flag', err);
        anomalyDecision = { isAnomaly: false, note: null };
      }
    }

    // ── Step 2: below-floor advisory ─────────────────────────────────────
    const floor = DOMAIN_POLICY[domain].sessionFloor;
    if (duration < floor && !decisions.belowFloorAck) {
      // Stash the anomaly decision on the modal so its confirm handler can
      // forward it without re-running the network check.
      pendingDecisionsRef.current = { ...decisions, anomaly: anomalyDecision };
      setStage('below-floor');
      return;
    }

    // Step 3: frequency advisory — compare against the selected day, not
    // wall-clock today, so backdating doesn't false-trigger (SOMR-304).
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

    // All clear → persist. resolveSessionTimestamp guards against invalid
    // input and clamps future timestamps (SOMR-304).
    const isoTimestamp = resolveSessionTimestamp(sessionDate).toISOString();
    const trimmedNotes = notes.trim();

    // Edit mode (SOMR-305): PATCH via the B2 correction path; no toast.
    // updateSessionSchema only accepts the four user-editable fields, so
    // the original anomaly flag is preserved on the row.
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
      if (result) {
        setLocation('/');
      } else {
        // Patch failed — restore the form so the user can retry rather
        // than silently dropping their edit.
        setStage('idle');
      }
      return;
    }

    // ── D1.2 (SOMR-305) new-session path — POST then show toast ──────────
    const saved = await addSession({
      domain,
      durationMinutes: duration,
      timestamp: isoTimestamp,
      notes: trimmedNotes || undefined,
      isAnomaly: anomalyDecision.isAnomaly,
      anomalyNote: anomalyDecision.isAnomaly ? anomalyDecision.note : null,
    });

    if (saved) {
      // Hand the user the post-save Undo/Edit window. The toast component
      // owns its own auto-dismiss timer; here we just stage it.
      savedSessionRef.current = saved;
      setToastDismissAt(Date.now() + POST_SAVE_TOAST_MS);
      setStage('saved');
    } else {
      // No canonical id to Undo against on server failure → skip the toast.
      // The fail-soft local insert in addSession preserves user input.
      setLocation('/');
    }
  };

  // Holds the in-flight decisions while a modal is open so confirm handlers
  // can resume the pipeline without losing prior decisions or re-running the
  // anomaly network check. Ref (not state) so updates are synchronous.
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

  // ── D1.2 (SOMR-305) post-save toast handlers ─────────────────────────────
  // Auto-dismiss timer: when the toast appears, schedule a navigation to the
  // dashboard so the user is never trapped if they walk away. Cleared on
  // unmount and on any explicit Undo/Edit/Dismiss interaction.
  useEffect(() => {
    if (stage !== 'saved') return;
    const t = window.setTimeout(() => {
      savedSessionRef.current = null;
      setLocation('/');
    }, POST_SAVE_TOAST_MS);
    return () => window.clearTimeout(t);
  }, [stage, setLocation]);

  // Tick the countdown bar by updating `toastNow` every ~100ms. The setTimeout
  // above remains the source of truth for auto-dismiss; this is purely visual.
  useEffect(() => {
    if (stage !== 'saved' || toastDismissAt === null) return;
    setToastNow(Date.now());
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
    // Soft-delete via the same B2 deletion path used elsewhere; no extra
    // confirmation prompt — the toast itself was the confirmation window.
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
    // Navigate to the same page in edit mode. A fresh mount picks up the
    // ?edit=<id> query param and pre-populates the form.
    setLocation(`/log?edit=${saved.id}`);
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

  // D1.1 (SOMR-304): preset set per .910 spec. Custom durations remain
  // available via the slider below — no separate "Custom" button needed.
  const durations = [5, 10, 15, 20, 30];
  const saving = stage === 'saving';
  const floor = DOMAIN_POLICY[domain].sessionFloor;
  // Recomputed every render so the cap moves forward in real time and
  // future timestamps cannot be selected.
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
                className={`p-4 rounded-xl border text-left transition-all active:scale-95 ${
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
            onChange={(e) => setSessionDate(e.target.value)}
            className="w-full bg-card border border-border/50 rounded-2xl p-4 text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all shadow-sm"
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
                className={`px-4 py-2.5 rounded-full text-sm font-medium transition-all active:scale-95 ${
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
            onChange={(e) => setDurationAndReset(Number(e.target.value))}
            className="w-full mt-6 accent-primary h-2 bg-muted rounded-lg appearance-none cursor-pointer"
            data-testid="input-duration-slider"
          />
        </section>

        {/* Notes */}
        <section className="space-y-3">
          <label className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Notes (Optional)</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="How did it go?"
            className="w-full bg-card border border-border/50 rounded-2xl p-4 min-h-[120px] resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 text-foreground placeholder:text-muted-foreground/50 transition-all shadow-sm"
            data-testid="input-notes"
          />
        </section>
      </main>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pb-8 pt-12 pointer-events-none">
        <button
          onClick={handleSave}
          disabled={saving}
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
          title="Already logged today"
          testId="modal-frequency"
          body={
            <p>
              You've already logged a {domain.replace('-', ' ')} session today. Logging another is
              fine — just confirming this isn't a duplicate.
            </p>
          }
          confirmLabel="Save anyway"
          onConfirm={onFrequencyConfirm}
          onCancel={onFrequencyCancel}
        />
      )}

      {/* ── Post-save Undo/Edit toast (D1.2 / SOMR-305) ───────────────── */}
      {stage === 'saved' && toastDismissAt !== null && (
        <PostSaveToast
          dismissAt={toastDismissAt}
          totalMs={POST_SAVE_TOAST_MS}
          onUndo={onPostSaveUndo}
          onEdit={onPostSaveEdit}
          onDismiss={onPostSaveDismiss}
        />
      )}
    </div>
  );
}

// Post-save toast (SOMR-305): Undo/Edit + shrinking countdown bar.
interface PostSaveToastProps {
  dismissAt: number;
  totalMs: number;
  onUndo: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}

function PostSaveToast({ dismissAt, totalMs, onUndo, onEdit, onDismiss }: PostSaveToastProps) {
  const remaining = Math.max(0, dismissAt - Date.now());
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
