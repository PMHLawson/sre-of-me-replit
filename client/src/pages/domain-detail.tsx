import { useLocation, useRoute } from 'wouter';
import { format, subDays, parseISO, isSameDay } from 'date-fns';
import { ArrowLeft, Clock, Plus, Activity, BrainCircuit, Dumbbell, Music } from 'lucide-react';
import { useAppStore, Domain } from '@/store';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceLine, Cell } from 'recharts';
import { ThemeToggle } from '@/components/theme-toggle';

const DomainIcon = ({ domain, className }: { domain: Domain, className?: string }) => {
  switch (domain) {
    case 'martial-arts': return <Activity className={className} />;
    case 'meditation': return <BrainCircuit className={className} />;
    case 'fitness': return <Dumbbell className={className} />;
    case 'music': return <Music className={className} />;
  }
};

const formatDomainName = (domain: string) => {
  return domain.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
};

export default function DomainDetail() {
  const [_, setLocation] = useLocation();
  const [match, params] = useRoute('/domain/:domain');
  
  const domain = (params?.domain as Domain) || 'fitness';
  const domainName = formatDomainName(domain);
  
  const sessions = useAppStore(state => state.sessions);
  const getDomainStatus = useAppStore(state => state.getDomainStatus);
  
  const domainSessions = sessions.filter(s => s.domain === domain);
  const { score, status, trend, recentMinutes, targetMinutes, previousWeekMinutes } = getDomainStatus(domain);
  
  // Generate last 7 days data for chart
  const chartData = Array.from({ length: 7 }).map((_, i) => {
    const date = subDays(new Date(), 6 - i); // 6 days ago to today
    
    // Sum minutes for this day
    const minutes = domainSessions
      .filter(s => isSameDay(parseISO(s.timestamp), date))
      .reduce((sum, s) => sum + s.durationMinutes, 0);
      
    return {
      date: format(date, 'EEE'),
      fullDate: format(date, 'MMM d'),
      minutes,
      isToday: i === 6
    };
  });

  const getStatusColor = () => {
    switch (status) {
      case 'healthy': return 'text-status-healthy';
      case 'degraded': return 'text-status-degraded';
      case 'critical': return 'text-status-critical';
      default: return 'text-primary';
    }
  };

  const getStatusBgColor = () => {
    switch (status) {
      case 'healthy': return 'bg-status-healthy/10';
      case 'degraded': return 'bg-status-degraded/10';
      case 'critical': return 'bg-status-critical/10';
      default: return 'bg-primary/10';
    }
  };

  const getDomainColorHex = () => {
    // These match the HSL values in index.css but simplified for Recharts
    switch (domain) {
      case 'martial-arts': return '#fb7185'; // Rose 400
      case 'meditation': return '#38bdf8'; // Sky 400
      case 'fitness': return '#34d399'; // Emerald 400
      case 'music': return '#a78bfa'; // Purple 400
      default: return '#94a3b8';
    }
  };

  // Get most recent 5 sessions
  const recentSessions = [...domainSessions]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 5);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans transition-colors duration-300 pb-24">
      <header className="px-4 py-5 flex items-center justify-between sticky top-0 bg-background/90 backdrop-blur-xl z-10 border-b border-border/40">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => {
              const params = new URLSearchParams(window.location.search);
              if (params.get('from') === 'system-health') {
                setLocation('/system-health');
              } else {
                setLocation('/');
              }
            }}
            className="p-2 -ml-2 rounded-full active:scale-95 hover:bg-accent/50 text-muted-foreground transition-all"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl bg-muted text-foreground`}>
              <DomainIcon domain={domain} className="w-5 h-5 opacity-70" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">{domainName}</h1>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="px-4 py-6 space-y-8">
        {/* Status Header */}
        <section className="bg-card border border-border/60 rounded-3xl p-6 shadow-sm">
          <div className="flex items-start justify-between mb-5">
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Current Status</div>
              <div className="flex items-center gap-3">
                <span className={`text-5xl font-extrabold tracking-tighter ${getStatusColor()}`}>
                  {score}
                </span>
                <div className={`px-3 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wide ${getStatusBgColor()} ${getStatusColor()}`}>
                  {status}
                </div>
              </div>
            </div>
            
            <div className="text-right">
              <div className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Vs. Last Week</div>
              <div className="flex flex-col items-end">
                <div className="flex items-center justify-end gap-1.5 font-bold text-xl">
                  {trend === 'up' && <><span className="text-status-healthy">↗</span> Up</>}
                  {trend === 'down' && <><span className="text-status-critical">↘</span> Down</>}
                  {trend === 'flat' && <><span className="text-blue-500">→</span> Flat</>}
                </div>
                <div className="text-xs font-medium text-muted-foreground mt-1">
                  ({recentMinutes}m vs {previousWeekMinutes}m)
                </div>
                <div className={`text-[11px] font-bold mt-1 px-2 py-0.5 rounded-md ${recentMinutes > previousWeekMinutes ? 'bg-status-healthy/10 text-status-healthy' : recentMinutes < previousWeekMinutes ? 'bg-status-critical/10 text-status-critical' : 'bg-blue-500/10 text-blue-500'}`}>
                  {recentMinutes - previousWeekMinutes > 0 ? '+' : ''}{recentMinutes - previousWeekMinutes}m Delta
                </div>
              </div>
            </div>
          </div>
          
          <div className="pt-4 border-t border-border/40">
            <p className="text-sm text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Trend Analysis:</strong> You logged <strong className="text-foreground">{recentMinutes}m</strong> in the last 7 days compared to <strong className="text-foreground">{previousWeekMinutes}m</strong> in the previous 7 days (a delta of {recentMinutes - previousWeekMinutes > 0 ? '+' : ''}{recentMinutes - previousWeekMinutes}m). The target is <strong className="text-foreground">{targetMinutes}m/week</strong>.
            </p>
          </div>
        </section>

        {/* Chart */}
        <section className="bg-card border border-border/60 rounded-3xl p-6 shadow-sm">
          <div className="text-sm font-semibold mb-6 text-foreground">Past 7 Days (Minutes)</div>
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis 
                  dataKey="date" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))', fontWeight: 500 }}
                  dy={10}
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))', fontWeight: 500 }}
                />
                <Tooltip 
                  cursor={{ fill: 'hsl(var(--muted)/0.3)' }}
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="bg-popover border border-border/50 p-3 rounded-xl shadow-lg text-sm">
                          <div className="font-semibold">{payload[0].payload.fullDate}</div>
                          <div className={`mt-1 font-bold`} style={{ color: getDomainColorHex() }}>{payload[0].value} mins</div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <ReferenceLine y={17} stroke="hsl(var(--muted-foreground)/0.4)" strokeDasharray="4 4" />
                <Bar dataKey="minutes" radius={[6, 6, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={entry.minutes > 0 ? getDomainColorHex() : 'hsl(var(--muted))'} 
                      fillOpacity={entry.isToday ? 1 : 0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-xs font-medium text-muted-foreground text-center mt-4">
            Target: ~17 mins/day (120/week)
          </div>
        </section>

        {/* Recent Logs */}
        <section>
          <div className="flex items-center justify-between mb-4 px-2">
            <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-widest">Recent Sessions</h2>
          </div>
          
          <div className="space-y-3">
            {recentSessions.length > 0 ? (
              recentSessions.map(session => (
                <div key={session.id} className="bg-card border border-border/60 rounded-2xl p-5 flex items-start justify-between group shadow-sm">
                  <div className="flex gap-4">
                    <div className="mt-0.5 text-muted-foreground/60">
                      <Clock className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="font-semibold text-sm text-foreground">
                        {format(parseISO(session.timestamp), 'MMM d, yyyy • h:mm a')}
                      </div>
                      {session.notes && (
                        <div className="text-sm text-muted-foreground mt-1.5 leading-relaxed line-clamp-2">
                          {session.notes}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="font-mono text-sm font-bold text-primary bg-primary/10 px-2.5 py-1.5 rounded-lg">
                    {session.durationMinutes}m
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-10 text-muted-foreground bg-card border border-border/60 rounded-3xl shadow-sm">
                No recent sessions found.
              </div>
            )}
          </div>
        </section>
      </main>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pb-8">
        <button
          onClick={() => setLocation(`/log?domain=${domain}`)}
          className="w-full h-14 rounded-full bg-primary text-primary-foreground font-semibold text-lg flex items-center justify-center gap-2 active:scale-95 transition-transform shadow-lg shadow-primary/20"
          data-testid="button-log-specific"
        >
          <Plus className="w-5 h-5" />
          Log {domainName}
        </button>
      </div>
    </div>
  );
}