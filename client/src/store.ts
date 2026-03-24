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
  getDomainStatus: (domain: Domain) => { score: number; trend: 'up' | 'down' | 'flat'; status: 'healthy' | 'degraded' | 'critical' };
  getWeakestDomain: () => Domain;
}

// Generate some initial mock data
const generateMockSessions = (): Session[] => {
  const sessions: Session[] = [];
  const now = new Date();
  const domains: Domain[] = ['martial-arts', 'meditation', 'fitness', 'music'];
  
  // Create roughly 30 days of history
  for (let i = 0; i < 30; i++) {
    domains.forEach(domain => {
      // Randomly skip some days to create realistic data
      if (Math.random() > 0.3) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        date.setHours(Math.floor(Math.random() * 14) + 6); // Random time between 6am and 8pm
        
        sessions.push({
          id: `mock-${i}-${domain}`,
          domain,
          durationMinutes: Math.floor(Math.random() * 60) + 15, // 15 to 75 mins
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
  
  const score = Math.min(100, Math.round((recentMinutes / 120) * 100));
  
  let trend: 'up' | 'down' | 'flat' = 'flat';
  if (recentMinutes > olderMinutesAvg * 1.2) trend = 'up';
  else if (recentMinutes < olderMinutesAvg * 0.8) trend = 'down';
  
  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
  if (score < 40) status = 'critical';
  else if (score < 70) status = 'degraded';
  
  return { score, trend, status };
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      sessions: generateMockSessions(),
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
        
        domains.forEach(d => {
          const { score } = calculateDomainStatus(sessions, d);
          if (score < lowestScore) {
            lowestScore = score;
            weakest = d;
          }
        });
        
        return weakest;
      }
    }),
    {
      name: 'sre-of-me-storage',
      // In a real app we'd use robust storage, for mockup we use localStorage via zustand persist
    }
  )
);
