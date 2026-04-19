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
 *   ESCALATION_CHANGE        → /                       (dashboard)
 *   INACTIVITY               → /                       (dashboard)
 *   COMPLIANCE_WARNING       → /domain/:domain         (per-domain page)
 *   DEVIATION_ENDING         → /domain/:domain
 *   OVERACHIEVEMENT_SUSTAINED→ /domain/:domain
 *   RAMP_UP_MILESTONE        → /history
 */

import type { Domain } from '@/store';

export type ClientTriggerType =
  | 'ESCALATION_CHANGE'
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
