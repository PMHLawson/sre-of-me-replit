import { useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Check, Clock, AlertTriangle, TrendingDown, Repeat } from 'lucide-react';
import { useAppStore, Domain, DOMAIN_POLICY } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';
import type { AnomalyCheckResponse } from '@shared/schema';

type Stage = 'idle' | 'anomaly' | 'below-floor' | 'frequency' | 'saving';

export default function LogSession() {
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const initialDomain = (searchParams.get('domain') as Domain) || 'martial-arts';

  const [domain, setDomain] = useState<Domain>(initialDomain);
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState('');
  const [stage, setStage] = useState<Stage>('idle');

  // Anomaly modal state — populated only while the anomaly modal is showing.
  const [anomalyResult, setAnomalyResult] = useState<AnomalyCheckResponse | null>(null);
  const [anomalyNote, setAnomalyNote] = useState('');

  const addSession = useAppStore(state => state.addSession);
  const sessions = useAppStore(state => state.sessions);

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

    // ── Step 3: frequency advisory (already logged this domain today) ────
    if (!decisions.frequencyAck) {
      const today = new Date();
      const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
      const hasToday = sessions.some((s) => {
        if (s.deletedAt) return false;
        if (s.domain !== domain) return false;
        const t = new Date(s.timestamp);
        const k = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
        return k === todayKey;
      });
      if (hasToday) {
        pendingDecisionsRef.current = { ...decisions, anomaly: anomalyDecision };
        setStage('frequency');
        return;
      }
    }

    // ── All clear → persist ──────────────────────────────────────────────
    await addSession({
      domain,
      durationMinutes: duration,
      timestamp: new Date().toISOString(),
      notes: notes.trim() || undefined,
      isAnomaly: anomalyDecision.isAnomaly,
      anomalyNote: anomalyDecision.isAnomaly ? anomalyDecision.note : null,
    });
    setLocation('/');
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

  const durations = [15, 30, 45, 60, 90, 120];
  const saving = stage === 'saving';
  const floor = DOMAIN_POLICY[domain].sessionFloor;

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
