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
| `client/src/store.ts` | Zustand store — holds sessions, fetches from API, computes domain status. Exports `DOMAIN_POLICY` with per-domain SLO targets |
| `client/src/App.tsx` | Root app — applies theme, triggers `fetchSessions` on mount |
| `client/src/pages/dashboard.tsx` | Main dashboard — composite health score with NOMINAL/ADVISORY/WARNING/BREACH labels, domain cards with explicit trend deltas |
| `client/src/pages/domain-detail.tsx` | Domain drill-down — 42-day scrollable chart (auto-scrolled to today), per-domain SLO targets and session floor, current/previous 7d comparison with delta badge |
| `client/src/pages/system-health.tsx` | Deep diagnostic — NOMINAL/ADVISORY/WARNING/BREACH escalation state, escalation protocol reference grid, domain state board |
| `client/src/pages/decide.tsx` | Priority-based decision engine — Notion-policy-aligned P1/P2/P3 qualifying criteria, current system escalation state banner, policy-based recommendations |
| `client/src/pages/history.tsx` | Session log with 14-day default and "Load Older Sessions" paginator |
| `client/src/pages/log-session.tsx` | Session logging — domain, duration, notes; POSTs to `/api/sessions` |
| `server/routes.ts` | API: `GET /api/sessions`, `POST /api/sessions` |
| `server/storage.ts` | DatabaseStorage — Drizzle CRUD over sessions and users |
| `server/db.ts` | Drizzle + pg Pool connection |
| `shared/schema.ts` | Drizzle schema for `sessions` and `users`; Zod insert schemas |

## Per-Domain SLO Policy (from Notion: 40.30.OCMP.010)

| Domain | 7-day Target | Session Floor | Cadence | Sessions/week |
|--------|-------------|---------------|---------|---------------|
| Martial Arts | 105 min | 15 min | Daily | 5+ |
| Meditation | 70 min | 10 min | Daily | 5+ |
| Fitness | 90 min | 15 min | 6×/week | 5+ |
| Music | 45 min | 15 min | 3×/week | 3+ |

## Domain Status Logic (Client-side, pure)

All status computation runs in `calculateDomainStatus()` in `store.ts`:

- **Target**: Per-domain from `DOMAIN_POLICY` (NOT a flat 120 min/week)
- **Score**: `min(100, round(recentMinutes / targetMinutes * 100))`
- **Status**: `score < 40` → critical (BREACH candidate); `score < 70` → degraded (WARNING); else healthy
- **Trend**: strict comparison — `recentMinutes > previousWeekMinutes` → up; `<` → down; equal → flat
- **previousWeekMinutes**: days 7–13 before today (inclusive)

## Escalation Protocol (Notion-aligned)

| State | Condition | Policy Action |
|-------|-----------|--------------|
| NOMINAL | All domains healthy, no downward trends | Full flex capacity |
| ADVISORY | All healthy, but 2+ domains trending down | Note & monitor; avoid new recurring commitments |
| WARNING | Any domain degraded (score 40–69) | Decline P3; time-box P2; makeup within 3 days |
| BREACH | Any domain critical (score < 40) | Cultivation = P1; decline all P2/P3 |

## Priority Classification (Notion-aligned)

- **P1 Emergency**: All three must be true — (1) immediate harm if not acting; (2) only you can act; (3) irreversible within 24h. Any no → not P1.
- **P2 Urgent**: All three must be true — (1) real consequence within 48h; (2) your involvement significantly changes outcome; (3) not caused by someone else's planning failure. Any no → not P2.
- **P3**: Everything else.

## 42-Day Scrollable Chart

`domain-detail.tsx` renders a 1100px-wide bar chart of the last 42 days, wrapped in `overflow-x-auto` and auto-scrolled to show today at the right edge on mount. Three opacity tiers: current 7d (100%), previous 7d (55%), older (28%). Reference line at per-domain daily pro-rate.

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
- Zustand persist key: `sre-of-me-v2` (only persists `theme`)
- PWA manifest.json must not be broken (Android install tested)
- Session duration badges in domain-detail: highlighted in `degraded` color if below session floor
