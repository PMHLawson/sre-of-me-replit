import { describe, it, expect } from 'vitest';
import {
  apiBackedDomainStatus,
  calculateDomainStatus,
  DOMAIN_POLICY,
  type Domain,
  type Session,
} from './store';
import type { PolicyStateResponse, ServiceState } from '@shared/schema';

const DOMAIN: Domain = 'martial-arts';

const daysAgo = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

const session = (durationMinutes: number, daysAgoNum: number, idx: number): Session => ({
  id: `s-${idx}`,
  domain: DOMAIN,
  durationMinutes,
  timestamp: daysAgo(daysAgoNum),
});

const buildPolicyState = (actualMinutes: number): PolicyStateResponse => {
  const policy = DOMAIN_POLICY[DOMAIN];
  const svc: ServiceState = {
    domain: DOMAIN,
    logical_day: '2026-01-01',
    actual_qualifying_days: 0,
    actual_minutes: actualMinutes,
    session_score: 0,
    duration_score: 0,
    service_score: 50,
    service_weight: 1,
    compliance_color: 'green',
    policy: {
      targetMinutes: policy.targetMinutes,
      sessionFloor: policy.sessionFloor,
      sessionsTarget: policy.sessionsTarget,
      cadence: policy.cadence,
      dailyProRate: policy.dailyProRate,
    },
    window_days: [],
  };
  return {
    logical_day: '2026-01-01',
    window_days: [],
    services: { [DOMAIN]: svc } as PolicyStateResponse['services'],
    composite_score: 50,
    composite_color: 'green',
  };
};

const expectedTrend = (recent: number, previous: number): 'up' | 'down' | 'flat' => {
  const sign = Math.sign(recent - previous);
  if (sign > 0) return 'up';
  if (sign < 0) return 'down';
  return 'flat';
};

describe('apiBackedDomainStatus trend matches displayed delta', () => {
  // Local previous-week minutes is computed from sessions in the (7,14] day window.
  const previousMinutes = 60;
  const previousSessions: Session[] = [session(previousMinutes, 10, 1)];

  const cases: Array<{ name: string; actualMinutes: number }> = [
    { name: 'positive delta -> up',  actualMinutes: previousMinutes + 30 },
    { name: 'negative delta -> down', actualMinutes: previousMinutes - 30 },
    { name: 'zero delta -> flat',     actualMinutes: previousMinutes },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const policyState = buildPolicyState(c.actualMinutes);
      const status = apiBackedDomainStatus(policyState, previousSessions, DOMAIN);

      expect(status.recentMinutes).toBe(c.actualMinutes);
      expect(status.previousWeekMinutes).toBe(previousMinutes);
      expect(status.trend).toBe(
        expectedTrend(status.recentMinutes, status.previousWeekMinutes)
      );
    });
  }
});

describe('calculateDomainStatus trend matches displayed delta', () => {
  // Recent window: timestamp >= today - 6 days (use 1 day ago).
  // Previous window: 7-13 days ago (use 10 days ago).
  const cases: Array<{ name: string; recent: number; previous: number }> = [
    { name: 'positive delta -> up',   recent: 90, previous: 60 },
    { name: 'negative delta -> down', recent: 30, previous: 60 },
    { name: 'zero delta -> flat',     recent: 60, previous: 60 },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const sessions: Session[] = [
        session(c.recent, 1, 1),
        session(c.previous, 10, 2),
      ];
      const status = calculateDomainStatus(sessions, DOMAIN);

      expect(status.recentMinutes).toBe(c.recent);
      expect(status.previousWeekMinutes).toBe(c.previous);
      expect(status.trend).toBe(
        expectedTrend(status.recentMinutes, status.previousWeekMinutes)
      );
    });
  }
});
