import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Loader2, Save } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAppStore } from '@/store';

const DAY_START_HOURS = [0, 1, 2, 3, 4, 5, 6];

const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

const WINDOW_DAY_CHOICES = [7, 14, 21, 30];

const NOTIFICATION_TIERS = ['ADVISORY', 'WARNING', 'BREACH', 'PAGE'] as const;

interface Settings {
  userId?: string;
  dayStartHour: number;
  timezone: string;
  windowDays: number;
  notificationsEnabled: boolean;
  notificationTier: string;
  updatedAt?: string;
}

const DEFAULTS: Settings = {
  dayStartHour: 4,
  timezone: 'America/New_York',
  windowDays: 7,
  notificationsEnabled: false,
  notificationTier: 'WARNING',
};

const ComingSoonBadge = () => (
  <span
    className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-muted text-muted-foreground"
    data-testid="badge-coming-soon"
  >
    Coming soon
  </span>
);

export default function SettingsPage() {
  const [_, setLocation] = useLocation();
  const { toast } = useToast();
  const fetchPolicyState = useAppStore((s) => s.fetchPolicyState);
  const fetchEscalationState = useAppStore((s) => s.fetchEscalationState);

  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tzMode, setTzMode] = useState<'list' | 'other'>('list');
  const [tzCustom, setTzCustom] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error('Failed to load settings');
        const data: Settings = await res.json();
        if (cancelled) return;
        setSettings({
          dayStartHour: data.dayStartHour ?? DEFAULTS.dayStartHour,
          timezone: data.timezone ?? DEFAULTS.timezone,
          windowDays: data.windowDays ?? DEFAULTS.windowDays,
          notificationsEnabled: data.notificationsEnabled ?? DEFAULTS.notificationsEnabled,
          notificationTier: data.notificationTier ?? DEFAULTS.notificationTier,
        });
        if (data.timezone && !TIMEZONE_OPTIONS.includes(data.timezone)) {
          setTzMode('other');
          setTzCustom(data.timezone);
        }
      } catch {
        if (!cancelled) setError('Could not load your settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    const tz = tzMode === 'other' ? tzCustom.trim() : settings.timezone;
    if (!tz) {
      setError('Timezone is required.');
      setSaving(false);
      return;
    }
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dayStartHour: settings.dayStartHour,
          timezone: tz,
          windowDays: settings.windowDays,
          notificationsEnabled: settings.notificationsEnabled,
          notificationTier: settings.notificationTier,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body?.message || 'Failed to save settings');
      }
      const saved: Settings = await res.json();
      setSettings({
        dayStartHour: saved.dayStartHour,
        timezone: saved.timezone,
        windowDays: saved.windowDays,
        notificationsEnabled: saved.notificationsEnabled,
        notificationTier: saved.notificationTier,
      });
      // C3.3 — Refresh derived state so the Dashboard reflects new knobs
      // immediately, no manual reload required.
      await Promise.all([fetchPolicyState(), fetchEscalationState()]);
      toast({ title: 'Settings saved', description: 'Your preferences have been updated.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save settings';
      setError(message);
      toast({ title: 'Could not save settings', description: message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground pb-24 font-sans">
      <header className="px-6 py-8 pb-4 flex items-center gap-3">
        <button
          onClick={() => setLocation('/')}
          className="w-10 h-10 rounded-full hover:bg-muted/60 flex items-center justify-center"
          aria-label="Back to dashboard"
          data-testid="button-back-dashboard"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Runtime Preferences
          </p>
        </div>
      </header>

      <main className="px-6 space-y-6 max-w-xl">
        {loading ? (
          <div className="flex items-center gap-3 text-muted-foreground py-8" data-testid="status-loading-settings">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading settings…
          </div>
        ) : (
          <>
            {/* Day-start hour */}
            <section className="bg-card border border-border/60 rounded-2xl p-5">
              <label className="block text-sm font-bold tracking-wide text-foreground mb-1">
                Day-start hour
              </label>
              <p className="text-xs text-muted-foreground mb-3">
                Sessions logged before this hour count as the previous calendar day.
              </p>
              <div className="flex flex-wrap gap-2" data-testid="group-day-start-hour">
                {DAY_START_HOURS.map((h) => {
                  const active = settings.dayStartHour === h;
                  const label = h === 4 ? '4 AM (default)' : `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
                  return (
                    <button
                      key={h}
                      type="button"
                      onClick={() => setSettings((s) => ({ ...s, dayStartHour: h }))}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/40 text-foreground border-border/60 hover:bg-muted'
                      }`}
                      data-testid={`button-day-start-${h}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Timezone */}
            <section className="bg-card border border-border/60 rounded-2xl p-5">
              <label className="block text-sm font-bold tracking-wide text-foreground mb-1">
                Timezone
              </label>
              <p className="text-xs text-muted-foreground mb-3">
                IANA timezone for evaluating logical-day boundaries.
              </p>
              <select
                value={tzMode === 'other' ? '__other__' : settings.timezone}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '__other__') {
                    setTzMode('other');
                    setTzCustom(settings.timezone);
                  } else {
                    setTzMode('list');
                    setSettings((s) => ({ ...s, timezone: v }));
                  }
                }}
                className="w-full bg-background border border-border/60 rounded-lg px-3 py-2 text-sm"
                data-testid="select-timezone"
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
                <option value="__other__">Other (specify)</option>
              </select>
              {tzMode === 'other' && (
                <input
                  type="text"
                  value={tzCustom}
                  onChange={(e) => setTzCustom(e.target.value)}
                  placeholder="e.g. Europe/Madrid"
                  className="mt-3 w-full bg-background border border-border/60 rounded-lg px-3 py-2 text-sm font-mono"
                  data-testid="input-timezone-custom"
                />
              )}
            </section>

            {/* Window days */}
            <section className="bg-card border border-border/60 rounded-2xl p-5">
              <label className="block text-sm font-bold tracking-wide text-foreground mb-1">
                Compliance window
              </label>
              <p className="text-xs text-muted-foreground mb-3">
                Number of trailing days used to compute SLO scores.
              </p>
              <div className="flex flex-wrap gap-2" data-testid="group-window-days">
                {WINDOW_DAY_CHOICES.map((d) => {
                  const active = settings.windowDays === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setSettings((s) => ({ ...s, windowDays: d }))}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted/40 text-foreground border-border/60 hover:bg-muted'
                      }`}
                      data-testid={`button-window-days-${d}`}
                    >
                      {d} days
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Notifications — settings-backed (transport in C4.3+) */}
            <section className="bg-card border border-border/60 rounded-2xl p-5">
              <h2 className="text-sm font-bold tracking-wide text-foreground mb-3">
                Notifications
              </h2>

              <div className="flex items-center justify-between py-2">
                <div>
                  <label className="block text-sm font-medium text-foreground">
                    Enable notifications
                  </label>
                  <p className="text-xs text-muted-foreground">Push when permitted; in-app badge fallback otherwise.</p>
                </div>
                <input
                  type="checkbox"
                  checked={settings.notificationsEnabled}
                  onChange={(e) => setSettings((s) => ({ ...s, notificationsEnabled: e.target.checked }))}
                  className="w-5 h-5 cursor-pointer accent-primary"
                  data-testid="toggle-notifications-enabled"
                />
              </div>

              <div className="mt-3">
                <label className="block text-sm font-medium text-foreground mb-1">
                  Minimum tier
                </label>
                <select
                  value={settings.notificationTier}
                  disabled={!settings.notificationsEnabled}
                  onChange={(e) => setSettings((s) => ({ ...s, notificationTier: e.target.value }))}
                  className={`w-full bg-background border border-border/60 rounded-lg px-3 py-2 text-sm ${settings.notificationsEnabled ? 'text-foreground' : 'text-muted-foreground cursor-not-allowed'}`}
                  data-testid="select-notification-tier"
                >
                  {NOTIFICATION_TIERS.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">Only events at or above this tier will alert you.</p>
              </div>
            </section>

            {error && (
              <div
                className="bg-status-critical/10 border border-status-critical/40 text-status-critical text-sm rounded-xl px-4 py-3"
                data-testid="text-settings-error"
              >
                {error}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onSave}
                disabled={saving || loading}
                className="h-11 px-6 rounded-full bg-primary text-primary-foreground font-semibold text-sm flex items-center gap-2 active:scale-95 transition-transform shadow-md shadow-primary/20 disabled:opacity-60 disabled:cursor-not-allowed"
                data-testid="button-save-settings"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save settings
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
