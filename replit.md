# SRE-of-Me

A mobile-first installable PWA for tracking and protecting four cultivation domains: martial arts, meditation, fitness, and music. Applies SRE (Site Reliability Engineering) mental models to personal habit maintenance.

## Architecture

**Full-stack Express + React + PostgreSQL, multi-user via Replit OIDC**

- **Frontend**: React (Vite), Wouter routing, Zustand for client state, TailwindCSS v4, Recharts
- **Backend**: Express.js (Node/TypeScript), Drizzle ORM
- **Database**: PostgreSQL (Replit-hosted), cultivation sessions persisted server-side, user-scoped
- **Auth**: Replit OIDC via `openid-client` + Passport.js. HTTP sessions stored in `http_sessions` table (connect-pg-simple). User records in `users` table. Routes: `/api/login`, `/api/callback`, `/api/logout`, `/api/auth/user`
- **PWA**: manifest.json + service worker for Android installability

## Auth Architecture

- **Server**: `setupAuth(app)` called before all routes in `server/index.ts`. Auth module lives in `server/replit_integrations/auth/`
- **Middleware**: `isAuthenticated` guards all `/api/sessions` routes. User claims available at `req.user.claims.sub` (stable userId)
- **Client**: `useAuth()` hook queries `/api/auth/user` via react-query. `client/src/App.tsx` shows `<Landing>` for unauthenticated users, app for authenticated users
- **Sessions**: cultivation sessions table has `userId` column (text, nullable for legacy rows). All queries scoped to the authenticated user
- **Table name note**: Replit Auth's HTTP session store uses `http_sessions` (not `sessions`) to avoid collision with the cultivation sessions table

## Key Files

| File | Purpose |
|------|---------|
| `client/src/store.ts` | Zustand store — holds sessions, fetches from API, computes domain status. Exports `DOMAIN_POLICY` with per-domain SLO targets |
| `client/src/App.tsx` | Root app — applies theme, auth-gates the app (shows Landing if not logged in, fetches sessions if authenticated) |
| `client/src/hooks/use-auth.ts` | Auth hook — queries `/api/auth/user`, exposes `user`, `isLoading`, `isAuthenticated`, `logout` |
| `client/src/lib/auth-utils.ts` | Auth utilities — `isUnauthorizedError`, `redirectToLogin` helpers |
| `client/src/pages/landing.tsx` | Landing page — shown to unauthenticated users; sign-in CTA → `/api/login` |
| `client/src/pages/dashboard.tsx` | Main dashboard — composite health score, domain cards, user avatar + logout menu in header |
| `client/src/pages/domain-detail.tsx` | Domain drill-down — 42-day scrollable chart, SLO targets, trend delta badge |
| `client/src/pages/system-health.tsx` | Deep diagnostic — NOMINAL/ADVISORY/WARNING/BREACH escalation state, escalation protocol grid |
| `client/src/pages/decide.tsx` | Priority-based decision engine — P1/P2/P3 criteria, policy-based recommendations |
| `client/src/pages/history.tsx` | Session log with 14-day default and "Load Older Sessions" paginator |
| `client/src/pages/log-session.tsx` | Session logging — domain, duration, notes; POSTs to `/api/sessions` |
| `server/replit_integrations/auth/` | Replit Auth module: `replitAuth.ts` (OIDC, passport), `storage.ts` (user upsert), `routes.ts` (`/api/auth/user`) |
| `server/routes.ts` | API: `GET /api/sessions`, `POST /api/sessions` — both protected by `isAuthenticated`, scoped to userId |
| `server/storage.ts` | DatabaseStorage — `getSessions(userId)`, `getSessionsSince(userId, since)`, `createSession({...data, userId})` |
| `server/db.ts` | Drizzle + pg Pool connection |
| `shared/schema.ts` | Drizzle schema — re-exports auth models, defines cultivation `sessions` table with `userId` column |
| `shared/models/auth.ts` | Auth models — `users` table, `httpSessions` table (http_sessions in DB) |

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
| GET | `/api/policy-state` | Per-service + composite policy fidelity (computed in `server/lib/policy-engine.ts`) |
| GET | `/api/escalation-state` | Per-domain escalation tier, error-budget, burn-rate, recommended action (computed in `server/lib/escalation.ts`) |

## Escalation Stitch Model (server/lib/escalation.ts)

Derived from the same session stream that feeds policy-state. Per-domain output:

- **Tier**: `NOMINAL` → `ADVISORY` → `WARNING` → `BREACH` → `PAGE`. Classification combines compliance color with `consecutiveLowDays` (trailing days in the window with no qualifying session). Red + 3 trailing low days → PAGE; yellow + 2 → WARNING; green + 3 → ADVISORY.
- **Error budget**: allowed deficit = 60% of `targetMinutes` (red bucket starts at <40% attainment). Tracks `consumedMinutes`, `remainingMinutes`, `percentRemaining`.
- **Burn rate**: `actualMinutesPerDay / dailyProRate` over the completed window. <1 = under target.
- **Recommended action**: one concrete operator next-step per tier, surfaced in dashboard strip + domain-detail card.

Client surface lives in `client/src/components/escalation-surface.tsx` (`EscalationCard`, `EscalationStrip`). Store slice: `escalationState`, `fetchEscalationState`. Hydrated alongside policy-state in `App.tsx` and refreshed after each `addSession`.

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

## Replit Task Board Intake Workflow (Owner-approved 2026/04/19 17:38 ET)

Standing governance pattern for any candidate work I surface during SOMR execution. Source: Notion deliberation `346f041f-c870-816b-921e-d23ad69aada6`. Status: OWNER_APPROVED, EFFECTIVE: IMMEDIATELY.

**Trigger and documentation**
1. Replit encounters candidate work mid-execution.
2. Replit finishes the **current sub-task**, then **stops** — does not proceed with the rest of the bundle.
3. Replit posts detailed structured comments on the **active Jira story shell** with stable local identifiers (`RTB-XX-NN`).
4. Replit flags the candidate work inside its **sub-task completion comment** with count and story-shell references (`⚠ CANDIDATE WORK SURFACED: <count>`). Completion-comment flag is the **guaranteed** trigger.
5. Direct ChatGPT notification attempted if platform supports; not relied on.
6. Replit does not resume work until ChatGPT responds with directions.

**Triage and disposition**
- ChatGPT initiates triage with Claude during normal four-eyes review.
- **Nine mandatory fields per item:** source sub-task, summary, rationale (verbose), suggested disposition, scope assessment, blocking assessment, timestamp, proposed Jira destination, stable local identifier.
- **Four dispositions only** (no APPROVE-Inline Fix):
  - **APPROVE — Backlog** (location-neutral: current checkpoint, later checkpoint, OP-2, or defect ticket)
  - **DEFER**
  - **ALREADY REPRESENTED**
  - **REJECT**
- **Philip approval mandatory for:** new out-of-scope tickets, .910/policy changes, AI disagreement, blocking items, re-sequencing of approved work.
- No implementation before disposition + Jira outcome (when Jira tracking is required).

**Clean rule**
- If it is already in scope, just do it.
- If it must be surfaced through intake, it must be tracked in Jira.

**Three guardrails**
- **G1 — No silent conversion:** Jira comment must exist before any work is done.
- **G2 (UPGRADED) — Four-eyes depth:** ChatGPT catches unauthorized work through story-level **changed-files review and targeted code inspection** against Jira scope, not commit-message checking.
- **G3 — Audit trail:** Jira story-shell comments are the audit trail.
