import { Activity, BrainCircuit, Dumbbell, Music, Shield, TrendingUp, BarChart2, ArrowRight } from 'lucide-react';

const FEATURES = [
  {
    icon: Activity,
    label: 'Martial Arts',
    color: '#C8743A',
    bg: 'rgba(200,116,58,0.12)',
    desc: 'Track training sessions',
  },
  {
    icon: BrainCircuit,
    label: 'Meditation',
    color: '#6B8EC4',
    bg: 'rgba(107,142,196,0.12)',
    desc: 'Monitor mindfulness',
  },
  {
    icon: Dumbbell,
    label: 'Fitness',
    color: '#5FAE6E',
    bg: 'rgba(95,174,110,0.12)',
    desc: 'Measure physical output',
  },
  {
    icon: Music,
    label: 'Music',
    color: '#7A6FD6',
    bg: 'rgba(122,111,214,0.12)',
    desc: 'Log practice time',
  },
];

const PILLARS = [
  {
    icon: BarChart2,
    title: 'SLO-Driven Scoring',
    desc: 'Each domain has a weekly target. Miss it and the system signals degraded — just like a production service.',
  },
  {
    icon: TrendingUp,
    title: '42-Day Trend View',
    desc: 'Daily bars show momentum at a glance. Spot burnout patterns before they become SLO breaches.',
  },
  {
    icon: Shield,
    title: 'Decision Framework',
    desc: 'Apply error-budget thinking before taking on new commitments. Protect recovery time the same way you protect system uptime.',
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      {/* Hero */}
      <div className="flex-1 flex flex-col px-6 pt-16 pb-8">
        <div className="mb-10">
          {/* Wordmark */}
          <div className="mb-3">
            <span className="text-4xl font-extrabold tracking-tight text-foreground">SRE</span>
            <span className="text-4xl font-extrabold tracking-tight text-primary">-of-Me</span>
          </div>
          <p className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">
            Personal System Reliability Engineering
          </p>
          <p className="text-base text-foreground/80 leading-relaxed max-w-xs">
            Apply SRE mental models — SLOs, error budgets, incident response — to the four cultivation domains that define your long-term capacity.
          </p>
        </div>

        {/* Domain pills */}
        <div className="grid grid-cols-2 gap-3 mb-10">
          {FEATURES.map(({ icon: Icon, label, color, bg, desc }) => (
            <div
              key={label}
              className="rounded-2xl p-4 border border-border/40 flex flex-col gap-2"
              style={{ background: bg }}
              data-testid={`card-domain-${label.toLowerCase().replace(' ', '-')}`}
            >
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: `${color}22` }}
              >
                <Icon className="w-4 h-4" style={{ color }} />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Sign-in CTA */}
        <a
          href="/api/login"
          className="w-full flex items-center justify-center gap-3 bg-primary text-primary-foreground rounded-2xl py-4 text-base font-bold tracking-wide shadow-lg shadow-primary/25 active:scale-[0.98] transition-transform"
          data-testid="button-sign-in"
        >
          Sign in with Replit
          <ArrowRight className="w-5 h-5" />
        </a>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Free to use. Your data stays private.
        </p>
      </div>

      {/* Pillars */}
      <div className="px-6 pb-12 space-y-4 border-t border-border/30 pt-8">
        {PILLARS.map(({ icon: Icon, title, desc }) => (
          <div key={title} className="flex gap-4 items-start">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Icon className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground mb-0.5">{title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
