// Independent invented numbers; never calls/imports backend, storage, or policy arithmetic.
const NOW = '2026-10-03T12:00:00.000Z', TODAY = '2026-10-03';
const domains = ['martial-arts', 'meditation', 'fitness', 'music'];
const policy = {
  music: { targetMinutes: 45, sessionFloor: 15, sessionsTarget: 3, cadence: '3×/week', dailyProRate: 6 },
  'martial-arts': { targetMinutes: 105, sessionFloor: 15, sessionsTarget: 5, cadence: 'Daily', dailyProRate: 15 },
  fitness: { targetMinutes: 90, sessionFloor: 15, sessionsTarget: 5, cadence: '6×/week', dailyProRate: 13 },
  meditation: { targetMinutes: 70, sessionFloor: 10, sessionsTarget: 5, cadence: 'Daily', dailyProRate: 10 },
};
// UTC date-key stepping is an independently supplied fixture, not server output verification.
const w42 = Array.from({ length: 42 }, (_, i) => new Date(Date.UTC(2026, 7, 22 + i)).toISOString().slice(0, 10));
const windowSets = { w42, w28: w42.slice(-28), w14: w42.slice(-14), w7: w42.slice(-7), prev7: w42.slice(-14, -7), todayKey: TODAY };
if (w42[0] !== '2026-08-22' || w42[41] !== '2026-10-02' || windowSets.w7[0] !== '2026-09-26' || windowSets.prev7[0] !== '2026-09-19') throw Error('Independent window literals disagree');
function createFixture(mode, origin) {
  const sessions = [], sessionDays = {}, requests = [], mutations = [], blocked = [];
  let settings = { dayStartHour: 4, timezone: 'America/New_York', windowDays: mode.startsWith('normalized-') ? 28 : 14, notificationsEnabled: false, notificationTier: 'WARNING' };
  const completed = mode !== 'empty' && mode !== 'today-only';
  const today = mode === 'empty' || mode === 'zero-today' ? 0 : mode === 'today-large' ? 200 : 20;
  function add(domain, key, minutes, note, anomaly = false) {
    const id = `invented-${domain}-${sessions.length}`;
    sessions.push({ id, userId: 'invented-browser-only', domain, durationMinutes: minutes,
      timestamp: `${key}T${key === TODAY ? '12' : '16'}:${String(sessions.length % 60).padStart(2, '0')}:00.000Z`,
      notes: note, isAnomaly: anomaly, anomalyNote: anomaly ? 'Invented deliberate outlier' : null, deletedAt: null });
    sessionDays[id] = key;
  }
  if (completed) {
    for (const domain of ['music', 'martial-arts']) {
      const older = domain === 'music' ? 5 : 3;
      const prev = domain === 'music' ? [20, 25, 30, 35, 40, 25, 25] : [10, 15, 15, 20, 10, 15, 15];
      const cur = domain === 'music' ? [10, 15, 20, 25, 30, 20, 20] : [5, 10, 10, 15, 10, 10, 10];
      if (mode === 'sparse') {
        add(domain, '2026-09-19', 200, 'Invented sparse previous');
        add(domain, '2026-09-26', 135, 'Invented sparse current');
        add(domain, '2026-10-02', 5, 'Invented below-floor current', true);
      } else {
        w42.forEach((key, i) => {
          const n = i < 28 ? older : i < 35 ? prev[i - 28] : cur[i - 35];
          // Duplicate day, including a below-floor entry, without duplicate IDs.
          if (i === 41) {
            add(domain, key, 5, 'Invented completed sub-floor');
            add(domain, key, n - 5, 'Invented completed note/anomaly', true);
          } else add(domain, key, n, 'Invented completed practice');
        });
      }
    }
  }
  if (today) {
    add('music', TODAY, today === 20 ? 8 : 80, 'Invented Today A');
    add('music', TODAY, today === 20 ? 12 : 120, 'Invented Today B', true);
    add('martial-arts', TODAY, 5, 'Invented second domain Today A');
    add('martial-arts', TODAY, 5, 'Invented second domain Today B');
  }
  const deviations = completed ? [{
    id: 'invented-music-deviation', userId: 'invented-browser-only', domain: 'music',
    reason: 'Invented recovery band', startAt: '2026-10-01T08:00:00.000Z', endAt: '2026-10-03T08:00:00.000Z',
    endedAt: null, deletedAt: null, excludeFromComposite: false,
  }] : [];
  const sums = (domain, keys) => sessions.filter(s => s.domain === domain && keys.includes(sessionDays[s.id])).reduce((n, s) => n + s.durationMinutes, 0);
  const expected = Object.fromEntries(['music', 'martial-arts'].map(domain => [domain, {
    current7: sums(domain, windowSets.w7), previous7: sums(domain, windowSets.prev7),
    completed: Object.fromEntries([7, 14, 28, 42].map(d => [d, sums(domain, w42.slice(-d))])),
    today: sums(domain, [TODAY]),
  }]));
  // Literal independently invented oracle for main reconciliation case.
  if (mode === 'dense' && JSON.stringify(expected.music) !== JSON.stringify({ current7: 140, previous7: 200, completed: { 7: 140, 14: 340, 28: 410, 42: 480 }, today: 20 })) throw Error('Invented totals do not match literal oracle');
  function policyResponse() {
    const complianceKeys = windowSets[`w${settings.windowDays}`];
    const services = Object.fromEntries(domains.map(domain => [domain, {
      domain, logical_day: TODAY, actual_qualifying_days: 3, actual_minutes: sums(domain, complianceKeys),
      session_score: 75, duration_score: 75, service_score: 75, service_weight: 0.25,
      compliance_color: 'amber', overachievement_raw: 0, overachievement_tier: 'NONE',
      policy: policy[domain], window_days: complianceKeys,
    }]));
    return { services, logical_day: TODAY, window_days: complianceKeys, composite_score: 75, composite_color: 'amber',
      excluded_domains: [], sustained_overachievement: Object.fromEntries(domains.map(d => [d, { consecutiveDays: 0, tier: 'NONE' }])),
      sessionDays, isRampUp: false, windowSets: { ...windowSets, deviationDayMap: { 'invented-music-deviation': ['2026-10-01', '2026-10-02'] } } };
  }
  function escalation(days) {
    return { logical_day: TODAY, highestTier: 'NOMINAL', isRampUp: false,
      history: w42.slice(-days).map(date => ({ logical_day: date, perDomain: Object.fromEntries(domains.map(d => [d, { tier: 'NOMINAL', percentRemaining: 100 }])), highestTier: 'NOMINAL' })),
      perDomain: Object.fromEntries(domains.map(d => [d, { domain: d, tier: 'NOMINAL', burnRate: 0, consecutiveLowDays: 0, rationale: 'Invented browser context', recommendedAction: 'Continue',
        errorBudget: { consumedMinutes: 0, allowedMinutes: 30, remainingMinutes: 30, percentRemaining: 100 } }])),
      composite: { tier: 'NOMINAL', displayStatus: 'NOMINAL', rationale: 'Invented browser context', recommendedAction: 'Continue', domainsByTier: { NOMINAL: domains, ADVISORY: [], WARNING: [], BREACH: [], PAGE: [] } } };
  }
  return { mode, sessions, deviations, sessionDays, expected, requests, mutations, blocked,
    get settings() { return settings; },
    async respond(request, requestId, rpc) {
      const u = new URL(request.url);
      if (u.origin !== origin) { blocked.push({ kind: 'external-network-blocked' }); return rpc('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
      if (!u.pathname.startsWith('/api/')) return rpc('Fetch.continueRequest', { requestId });
      requests.push({ method: request.method, path: u.pathname, query: u.search });
      let status = 200, value;
      if (u.pathname === '/api/settings' && request.method === 'PATCH') {
        const body = JSON.parse(request.postData || '{}');
        mutations.push({ method: request.method, path: u.pathname, body });
        if (![7, 14, 28, 42].includes(body.windowDays)) { status = 400; value = { message: 'Synthetic canonical values only' }; }
        else { settings = { ...settings, ...body }; value = { userId: 'invented-browser-only', ...settings, updatedAt: NOW }; }
      } else if (request.method !== 'GET') { status = 405; value = { message: 'Non-settings fixture mutations denied' }; }
      else if (u.pathname === '/api/auth/user') value = { id: 'invented-browser-only', firstName: 'Invented', createdAt: '2026-01-01T00:00:00.000Z' };
      else if (u.pathname === '/api/sessions') value = sessions;
      else if (u.pathname === '/api/deviations') value = deviations;
      else if (u.pathname === '/api/settings') value = { userId: 'invented-browser-only', ...settings, updatedAt: NOW };
      else if (u.pathname === '/api/policy-state') value = policyResponse();
      else if (u.pathname === '/api/escalation-state') value = escalation(Number(u.searchParams.get('days') || 14));
      else if (u.pathname === '/api/baselines') value = { baselineDays: 42, coldStartThreshold: 8, perDomain: Object.fromEntries(domains.map(d => [d, { coldStart: false, sampleCount: 8, mean: 30, stdDev: 10 }])) };
      else if (u.pathname === '/api/notifications') value = [];
      else if (u.pathname.includes('notifications') && u.pathname.endsWith('count')) value = { count: 0, unreadCount: 0 };
      else { status = 404; value = { message: 'No backend/live API allowed in verification' }; }
      return rpc('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(value)).toString('base64') });
    },
  };
}
module.exports = { createFixture, NOW, TODAY, windowSets, policy };