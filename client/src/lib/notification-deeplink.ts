/**
 * C4.4 — Deep-link routing for notification trigger events.
 *
 * Maps a server-emitted TriggerEvent (from server/lib/notifications.ts)
 * to a client-side route path. Used by:
 *   - the in-app NotificationBell, when adding a notification to the
 *     pending queue (so the row click navigates to the right surface).
 *   - any caller that wants to convert a raw trigger event into the
 *     shape expected by the store's `addPendingNotification`.
 *
 * The service worker (client/public/service-worker.js) carries an
 * equivalent mapping for push events that arrive when the SPA isn't
 * mounted; the two must stay in sync.
 *
 * Routing table:
 *   ESCALATION_CHANGE         → /                       (dashboard, worsening)
 *   ESCALATION_RECOVERY       → /                       (dashboard, improving)
 *   INACTIVITY                → /                       (dashboard)
 *   COMPLIANCE_WARNING        → /domain/:domain         (per-domain page)
 *   DEVIATION_ENDING          → /domain/:domain
 *   OVERACHIEVEMENT_SUSTAINED → /domain/:domain
 *   RAMP_UP_MILESTONE         → /history
 */

import type { Domain } from '@/store';

/**
 * Same-origin path allowlist. Mirrors the SW's sanitizePath/DEEPLINK_*.
 * Any deep-link target must match one of these prefixes (exact for "/"
 * and "/history" etc, prefix for "/domain/"). Blocks open-redirect via
 * push payloads carrying absolute URLs or arbitrary paths.
 */
const DEEPLINK_PREFIXES = ['/domain/'];
const DEEPLINK_EXACT = new Set([
  '/',
  '/history',
  '/settings',
  '/system-health',
  '/decide',
  '/log',
]);

/**
 * Returns the input path if it is a same-origin app route in the
 * allowlist; otherwise '/'. Strips query/hash for the allowlist check
 * but preserves them in the returned value on success.
 */
export function sanitizeDeepLinkPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return '/';
  if (!raw.startsWith('/')) return '/';
  const pathOnly = raw.split(/[?#]/, 1)[0];
  if (DEEPLINK_EXACT.has(pathOnly)) return raw;
  for (const prefix of DEEPLINK_PREFIXES) {
    if (pathOnly.startsWith(prefix) && pathOnly.length > prefix.length) return raw;
  }
  return '/';
}

export type ClientTriggerType =
  | 'ESCALATION_CHANGE'
  | 'ESCALATION_RECOVERY'
  | 'COMPLIANCE_WARNING'
  | 'DEVIATION_ENDING'
  | 'RAMP_UP_MILESTONE'
  | 'OVERACHIEVEMENT_SUSTAINED'
  | 'INACTIVITY';

export interface MinimalTriggerEvent {
  id: string;
  type: ClientTriggerType;
  severity: 'ADVISORY' | 'WARNING' | 'BREACH' | 'PAGE';
  title: string;
  body: string;
  domain?: Domain;
}

/**
 * Returns the client route path for a trigger event. Domain-scoped
 * triggers without a domain fall back to the dashboard so we never
 * navigate to a malformed URL.
 */
export function deepLinkForTrigger(event: MinimalTriggerEvent): string {
  switch (event.type) {
    case 'ESCALATION_CHANGE':
    case 'ESCALATION_RECOVERY':
    case 'INACTIVITY':
      return '/';
    case 'COMPLIANCE_WARNING':
    case 'DEVIATION_ENDING':
    case 'OVERACHIEVEMENT_SUSTAINED':
      return event.domain ? `/domain/${encodeURIComponent(event.domain)}` : '/';
    case 'RAMP_UP_MILESTONE':
      return '/history';
    default:
      return '/';
  }
}

/**
 * Convert a TriggerEvent (engine output shape) into the payload accepted
 * by `addPendingNotification`. Intentionally permissive on input — we
 * only require the fields the store actually uses, so this works with
 * either the strict `TriggerEvent` discriminated union or the looser
 * payload that arrives over a push event.
 */
export function triggerToNotificationPayload(event: MinimalTriggerEvent): {
  id: string;
  type: string;
  severity: 'ADVISORY' | 'WARNING' | 'BREACH' | 'PAGE';
  title: string;
  body: string;
  domain?: Domain;
  deepLink: string;
} {
  return {
    id: event.id,
    type: event.type,
    severity: event.severity,
    title: event.title,
    body: event.body,
    domain: event.domain,
    deepLink: deepLinkForTrigger(event),
  };
}
