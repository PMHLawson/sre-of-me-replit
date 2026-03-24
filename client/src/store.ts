import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Domain = 'martial-arts' | 'meditation' | 'fitness' | 'music';

export interface Session {
  id: string;
  domain: Domain;
  durationMinutes: number;
  timestamp: string;
  notes?: string;
}

interface AppState {
  sessions: Session[];
  addSession: (session: Omit<Session, 'id'>) => void;
  getDomainStatus: (domain: Domain) => { score: number; trend: 'up' | 'down' | 'flat'; status: 'healthy' | 'degraded' | 'critical'; recentMinutes: number; targetMinutes: number; };
  getWeakestDomain: () => { domain: Domain; isDegradedOrCritical: boolean };
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  demoState: 'default' | 'overperforming' | 'degraded' | 'mixed';
  setDemoState: (state: 'default' | 'overperforming' | 'degraded' | 'mixed') => void;
}

// Generate some initial mock data
const generateMockSessions = (scenario: 'default' | 'overperforming' | 'degraded' | 'mixed' = 'default'): Session[] => {
  const sessions: Session[] = [];
  const now = new Date();
  const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
  
  for (let i = 0; i < 30; i++) {
    domains.forEach(domain => {
      let probability = 0.3; // Default 70% chance of skipping a day
      let baseDuration = 30;
      
      if (scenario === 'overperforming') {
        probability = 0.8; // 80% chance of hitting it
        baseDuration = 45;
      } else if (scenario === 'degraded') {
        probability = 0.15; // 15% chance
        baseDuration = 15;
      } else if (scenario === 'mixed') {
        if (domain === 'fitness' || domain === 'music') {
          probability = 0.8;
          baseDuration = 45;
        } else {
          probability = 0.1;
          baseDuration = 15;
        }
      }

      if (Math.random() < probability) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        date.setHours(Math.floor(Math.random() * 14) + 6);
        
        sessions.push({
          id: `mock-${i}-${domain}`,
          domain,
          durationMinutes: Math.floor(Math.random() * 30) + baseDuration,
          timestamp: date.toISOString(),
        });
      }
    });
  }
  return sessions;
};

// Helper function to calculate domain status
const calculateDomainStatus = (sessions: Session[], domain: Domain) => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  const domainSessions = sessions.filter(s => s.domain === domain);
  const recentSessions = domainSessions.filter(s => new Date(s.timestamp) >= sevenDaysAgo);
  const olderSessions = domainSessions.filter(s => {
    const date = new Date(s.timestamp);
    return date >= thirtyDaysAgo && date < sevenDaysAgo;
  });
  
  // Simple scoring: minutes per week. Target: ~120 mins/week (score 100)
  const recentMinutes = recentSessions.reduce((sum, s) => sum + s.durationMinutes, 0);
  const olderMinutesAvg = olderSessions.reduce((sum, s) => sum + s.durationMinutes, 0) / (23 / 7); // Avg per week in the older period
  
  const targetMinutes = 120;
  const score = Math.min(100, Math.round((recentMinutes / targetMinutes) * 100));
  
  let trend: 'up' | 'down' | 'flat' = 'flat';
  if (recentMinutes > olderMinutesAvg * 1.2) trend = 'up';
  else if (recentMinutes < olderMinutesAvg * 0.8) trend = 'down';
  
  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
  if (score < 40) status = 'critical';
  else if (score < 70) status = 'degraded';
  
  return { score, trend, status, recentMinutes, targetMinutes };
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      sessions: generateMockSessions('default'),
      theme: 'dark',
      demoState: 'default',
      setDemoState: (demoState) => set({ 
        demoState, 
        sessions: generateMockSessions(demoState) 
      }),
      toggleTheme: () => {
        set((state) => {
          const newTheme = state.theme === 'dark' ? 'light' : 'dark';
          // Update the DOM class for tailwind
          const root = window.document.documentElement;
          root.classList.remove('light', 'dark');
          root.classList.add(newTheme);
          return { theme: newTheme };
        });
      },
      addSession: (session) => 
        set((state) => ({
          sessions: [{ ...session, id: crypto.randomUUID() }, ...state.sessions]
        })),
      
      getDomainStatus: (domain: Domain) => {
        const { sessions } = get();
        return calculateDomainStatus(sessions, domain);
      },
      
      getWeakestDomain: () => {
        const { sessions } = get();
        const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
        
        let weakest: Domain = 'fitness';
        let lowestScore = 101;
        let isDegradedOrCritical = false;
        
        domains.forEach(d => {
          const { score, status } = calculateDomainStatus(sessions, d);
          if (score < lowestScore) {
            lowestScore = score;
            weakest = d;
          }
          if (status === 'critical' || status === 'degraded') {
            isDegradedOrCritical = true;
          }
        });
        
        // Return boolean to indicate if the weakest domain actually needs urgent attention
        return { domain: weakest, isDegradedOrCritical };
      }
    }),
    {
      name: 'sre-of-me-storage',
      // In a real app we'd use robust storage, for mockup we use localStorage via zustand persist
    }
  )
);
