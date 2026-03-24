import { useLocation, useRoute } from 'wouter';
import { format, subDays, parseISO, isSameDay } from 'date-fns';
import { ArrowLeft, Clock, Plus, Activity, BrainCircuit, Dumbbell, Music } from 'lucide-react';
import { useAppStore, Domain } from '@/store';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceLine, Cell } from 'recharts';

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
  const { score, status, trend } = getDomainStatus(domain);
  
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
    <div className="min-h-screen bg-background text-foreground font-sans transition-colors duration-200 pb-24">
      <header className="px-4 py-4 flex items-center justify-between sticky top-0 bg-background/80 backdrop-blur-md z-10 border-b border-border/50">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setLocation('/')}
            className="p-2 -ml-2 rounded-full active:bg-black/5 dark:active:bg-white/5"
          >
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2">
            <div className={`p-1.5 rounded-lg bg-${domain}/10 text-${domain}`}>
              <DomainIcon domain={domain} className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-medium tracking-tight">{domainName}</h1>
          </div>
        </div>
      </header>

      <main className="px-4 py-6 space-y-8">
        {/* Status Header */}
        <section className="flex items-center justify-between">
          <div>
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">Current Status</div>
            <div className="flex items-center gap-3">
              <span className={`text-4xl font-bold tracking-tighter ${getStatusColor()}`}>
                {score}
              </span>
              <div className={`px-2.5 py-1 rounded-full text-xs font-medium uppercase tracking-wider ${getStatusBgColor()} ${getStatusColor()}`}>
                {status}
              </div>
            </div>
          </div>
          
          <div className="text-right">
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">Trend</div>
            <div className="flex items-center justify-end gap-1.5 font-medium text-lg">
              {trend === 'up' && <><span className="text-emerald-500">↗</span> Up</>}
              {trend === 'down' && <><span className="text-rose-500">↘</span> Down</>}
              {trend === 'flat' && <><span className="text-blue-500">→</span> Flat</>}
            </div>
          </div>
        </section>

        {/* Chart */}
        <section className="bg-card border border-border/50 rounded-2xl p-5 shadow-sm">
          <div className="text-sm font-medium mb-6 text-foreground">Past 7 Days (Minutes)</div>
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <XAxis 
                  dataKey="date" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                  dy={10}
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                />
                <Tooltip 
                  cursor={{ fill: 'hsl(var(--muted)/0.3)' }}
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      return (
                        <div className="bg-popover border border-border p-2 rounded-lg shadow-lg text-sm">
                          <div className="font-medium">{payload[0].payload.fullDate}</div>
                          <div className="text-primary mt-1">{payload[0].value} mins</div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <ReferenceLine y={17} stroke="hsl(var(--muted-foreground)/0.3)" strokeDasharray="3 3" />
                <Bar dataKey="minutes" radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell 
                      key={`cell-${index}`} 
                      fill={entry.minutes > 0 ? getDomainColorHex() : 'hsl(var(--muted))'} 
                      fillOpacity={entry.isToday ? 1 : 0.7}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="text-xs text-muted-foreground text-center mt-4">
            Target: ~17 mins/day (120/week)
          </div>
        </section>

        {/* Recent Logs */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium text-foreground">Recent Sessions</h2>
          </div>
          
          <div className="space-y-3">
            {recentSessions.length > 0 ? (
              recentSessions.map(session => (
                <div key={session.id} className="bg-card border border-border/50 rounded-xl p-4 flex items-start justify-between group">
                  <div className="flex gap-3">
                    <div className="mt-0.5 text-muted-foreground">
                      <Clock className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-medium text-sm text-foreground">
                        {format(parseISO(session.timestamp), 'MMM d, yyyy • h:mm a')}
                      </div>
                      {session.notes && (
                        <div className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {session.notes}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="font-mono text-sm font-medium text-primary bg-primary/10 px-2 py-1 rounded">
                    {session.durationMinutes}m
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-muted-foreground bg-card border border-border/50 rounded-xl">
                No recent sessions found.
              </div>
            )}
          </div>
        </section>
      </main>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pb-8">
        <button
          onClick={() => setLocation(`/log?domain=${domain}`)}
          className="w-full h-14 rounded-2xl bg-primary text-primary-foreground font-semibold text-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-transform shadow-lg"
          data-testid="button-log-specific"
        >
          <Plus className="w-5 h-5" />
          Log {domainName}
        </button>
      </div>
    </div>
  );
}