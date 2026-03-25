import { useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowLeft, Check, Clock } from 'lucide-react';
import { useAppStore, Domain } from '@/store';
import { ThemeToggle } from '@/components/theme-toggle';

export default function LogSession() {
  const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const initialDomain = (searchParams.get('domain') as Domain) || 'martial-arts';
  
  const [domain, setDomain] = useState<Domain>(initialDomain);
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState('');
  
  const addSession = useAppStore(state => state.addSession);
  
  const handleSave = () => {
    addSession({
      domain,
      durationMinutes: duration,
      timestamp: new Date().toISOString(),
      notes: notes.trim() || undefined
    });
    setLocation('/');
  };

  const domains: { id: Domain; label: string }[] = [
    { id: 'martial-arts', label: 'Martial Arts' },
    { id: 'meditation', label: 'Meditation' },
    { id: 'fitness', label: 'Fitness' },
    { id: 'music', label: 'Music' }
  ];

  const durations = [15, 30, 45, 60, 90, 120];

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
                onClick={() => setDomain(d.id)}
                className={`p-4 rounded-xl border text-left transition-all active:scale-95 ${
                  domain === d.id 
                    ? `border-primary bg-primary/5 text-primary ring-1 ring-primary/20` 
                    : 'border-border/50 bg-card text-muted-foreground hover:bg-accent/50'
                }`}
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
                onClick={() => setDuration(m)}
                className={`px-4 py-2.5 rounded-full text-sm font-medium transition-all active:scale-95 ${
                  duration === m
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-card border border-border/50 text-foreground hover:bg-accent/50'
                }`}
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
            onChange={(e) => setDuration(Number(e.target.value))}
            className="w-full mt-6 accent-primary h-2 bg-muted rounded-lg appearance-none cursor-pointer"
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
          />
        </section>
      </main>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background to-transparent pb-8 pt-12 pointer-events-none">
        <button
          onClick={handleSave}
          className="w-full h-14 rounded-2xl bg-primary text-primary-foreground font-semibold text-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-transform shadow-lg shadow-primary/20 pointer-events-auto"
          data-testid="button-save-session"
        >
          <Check className="w-5 h-5" />
          Save Session
        </button>
      </div>
    </div>
  );
}