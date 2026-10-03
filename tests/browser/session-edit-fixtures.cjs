// In-memory synthetic records only. Never imports the app backend or database.
const initial = {
  id: 'synthetic-edit', userId: 'synthetic-viewer', domain: 'music', durationMinutes: 30,
  timestamp: '2026-09-20T12:00:00.000Z', notes: 'synthetic original notes',
  deletedAt: null, isAnomaly: false, anomalyNote: null,
};
const domains = ['martial-arts', 'meditation', 'fitness', 'music'];
const services = Object.fromEntries(domains.map(domain => [domain, {
  domain, logical_day: '2026-10-03', actual_qualifying_days: 0, actual_minutes: 0,
  session_score: 0, duration_score: 0, service_score: 0, service_weight: 0.25,
  compliance_color: 'red', overachievement_raw: 0, overachievement_tier: 'NONE',
  policy: { targetMinutes: 105, sessionFloor: 15, sessionsTarget: 5, cadence: 'Regular', dailyProRate: 15 },
  window_days: [],
}]));
const policy = { services, logical_day: '2026-10-03', window_days: [],
  composite_score: 0, composite_color: 'red', excluded_domains: [],
  sustained_overachievement: Object.fromEntries(domains.map(d => [d, { consecutiveDays: 0, tier: 'NONE' }])),
  sessionDays: {}, isRampUp: false,
  windowSets: { w7: [], w14: [], w28: [], w42: [], prev7: [], deviationDayMap: {}, todayKey: '2026-10-03' } };
const escalation = {
  logical_day: '2026-10-03', highestTier: 'NOMINAL', isRampUp: false, history: [],
  perDomain: Object.fromEntries(domains.map(d => [d, {
    domain: d, tier: 'NOMINAL', burnRate: 0, consecutiveLowDays: 0,
    rationale: 'Synthetic fixture', recommendedAction: 'Continue practice',
    errorBudget: { consumedMinutes: 0, allowedMinutes: 30, remainingMinutes: 30, percentRemaining: 100 },
  }])),
  composite: { tier: 'NOMINAL', displayStatus: 'NOMINAL', rationale: 'Synthetic fixture',
    recommendedAction: 'Continue practice', domainsByTier: { NOMINAL: domains, ADVISORY: [], WARNING: [], BREACH: [], PAGE: [] } },
};

function fixture(mode, origin) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Owned fixture origin required');
  const create = mode.startsWith('create-');
  let session = create ? null : structuredClone(initial);
  if (mode === 'clear-prior') {
    session.isAnomaly = true;
    session.anomalyNote = 'prior synthetic explanation';
  }
  const before = structuredClone(session);
  const writes = [], checks = [];
  return {
    before, writes, checks, get session() { return session; },
    async respond(request, requestId, rpc) {
      const u = new URL(request.url);
      // Deny external traffic; never forward a fixture request to a real service.
      if (u.origin !== origin) {
        return rpc('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
      if (!u.pathname.startsWith('/api/')) return rpc('Fetch.continueRequest', { requestId });
      let status = 200, value;
      if (u.pathname === '/api/auth/user') {
        value = { id: 'synthetic-viewer', firstName: 'Fixture', createdAt: '2026-01-01T00:00:00Z' };
      } else if (u.pathname === '/api/sessions/anomaly-check') {
        const candidate = JSON.parse(request.postData);
        checks.push(candidate);
        if (mode === 'fail-open-network') return rpc('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        if (mode === 'fail-open-http') {
          status = 500; value = { message: 'Synthetic unavailable check' };
        } else {
          // All classification fixtures model eight valid 20/40-minute samples.
          const zScore = Math.abs(candidate.durationMinutes - 30) / 10;
          value = { isAnomaly: zScore > 2, coldStart: false, sampleCount: 8, mean: 30, stdDev: 10, zScore };
        }
      } else if (
        (u.pathname === '/api/sessions/synthetic-edit' && request.method === 'PATCH' && !create) ||
        (u.pathname === '/api/sessions' && request.method === 'POST' && create)
      ) {
        const body = JSON.parse(request.postData);
        writes.push({ method: request.method, body });
        if (mode === 'save-failure') {
          status = 500; value = { message: 'Synthetic save failure' };
        } else {
          const { reason, ...fields } = body;
          // Do not supply missing metadata on behalf of the client: the
          // regression must fail if the real save payload omits either field.
          session = create
            ? { ...initial, ...fields, id: 'synthetic-created', notes: fields.notes ?? null }
            : { ...session, ...fields };
          value = session;
        }
      } else if (request.method !== 'GET') {
        status = 405; value = { message: 'Unexpected fixture mutation rejected' };
      } else if (u.pathname === '/api/sessions') value = session ? [session] : [];
      else if (u.pathname === '/api/policy-state') value = policy;
      else if (u.pathname === '/api/escalation-state') value = escalation;
      else if (u.pathname === '/api/deviations') value = [];
      else { status = 404; value = { message: 'No live API in fixture browser' }; }
      return rpc('Fetch.fulfillRequest', { requestId, responseCode: status,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(value)).toString('base64') });
    },
  };
}
module.exports = { fixture };