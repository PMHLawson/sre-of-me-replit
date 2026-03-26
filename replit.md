# SRE-of-Me

A mobile-first installable PWA for tracking and protecting four cultivation domains: martial arts, meditation, fitness, and music. Applies SRE (Site Reliability Engineering) mental models to personal habit maintenance.

## Architecture

**Full-stack Express + React + PostgreSQL**

- **Frontend**: React (Vite), Wouter routing, Zustand for client state, TailwindCSS v4, Recharts
- **Backend**: Express.js (Node/TypeScript), Drizzle ORM
- **Database**: PostgreSQL (Replit-hosted), sessions persisted server-side
- **PWA**: manifest.json + service worker for Android installability

## Key Files

| File | Purpose |
|------|---------|
| `client/src/store.ts` | Zustand store — holds sessions, fetches from API, computes domain status |
| `client/src/App.tsx` | Root app — applies theme, triggers `fetchSessions` on mount |
| `client/src/pages/dashboard.tsx` | Main dashboard — composite health score, domain cards with explicit trend deltas |
| `client/src/pages/domain-detail.tsx` | Domain drill-down — 7-day chart, current/previous week comparison, delta badge |
| `client/src/pages/system-health.tsx` | Deep diagnostic — domain state board, insights, back-nav to system-health |
| `client/src/pages/decide.tsx` | Priority-based decision engine — P1/P2/P3 with expanded descriptions |
| `client/src/pages/history.tsx` | Session log with 14-day default and "Load Older Sessions" paginator |
| `client/src/pages/log-session.tsx` | Session logging — domain, duration, notes; POSTs to `/api/sessions` |
| `server/routes.ts` | API: `GET /api/sessions`, `POST /api/sessions` |
| `server/storage.ts` | DatabaseStorage — Drizzle CRUD over sessions and users |
| `server/db.ts` | Drizzle + pg Pool connection |
| `shared/schema.ts` | Drizzle schema for `sessions` and `users`; Zod insert schemas |

## Domain Status Logic (Client-side, pure)

All status computation runs in the browser over the session array:

- **Target**: 120 mins/week per domain
- **Score**: `min(100, round(recentMinutes / 120 * 100))`
- **Status**: `score < 40` → critical; `score < 70` → degraded; else healthy
- **Trend**: strict comparison of current 7-day total vs previous 7-day total (no fuzzy threshold)
- **previousWeekMinutes**: days 7–13 before today (inclusive)

## Scenario Validation (Demo States)

The "Data" selector in the dashboard generates mock sessions client-side for auditing scenario states: Standard (real DB data), Healthy, Degraded, Mixed. Switching back to "Standard" re-fetches from the database.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | All sessions, ordered by timestamp desc |
| POST | `/api/sessions` | Create a new session (validates via Zod) |

## Development

```bash
npm run dev        # starts Express + Vite dev server on :5000
npm run db:push    # push Drizzle schema to PostgreSQL
```

## Design Constraints

- Dark mode default; global theme toggle persisted in localStorage
- Mobile-first layout; all interactive elements use `active:scale` for touch feedback
- Recharts: hardcoded hex colors only (CSS variables don't render in SVG)
- Weakest-domain blinking dot only shows if `isDegradedOrCritical` is true
- System Health back-nav: domain detail reads `?from=system-health` query param
- Zustand persist key: `sre-of-me-storage` (only persists `theme`)
- PWA manifest.json must not be broken (Android install tested)
