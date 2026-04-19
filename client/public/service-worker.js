/**
 * SRE-of-Me service worker — C4.3 / C4.4.
 *
 * Minimal scope:
 *  - install / activate quickly with no caching strategy (PWA shell only).
 *  - on `push` events, show a notification carrying a `data.deepLink` URL.
 *  - on `notificationclick`, focus an existing window or open a new one
 *    at the deep-link path so the user lands on the relevant surface.
 *
 * No VAPID subscription handling, no offline cache — those are deferred to
 * later checkpoints. Push delivery in dev/preview is exercised via the
 * client-side `showNotification` fallback in NotificationBell.
 */

self.addEventListener('install', (event) => {
  // Activate this worker immediately on install.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Same-origin path allowlist. Any deep-link target must match one of these
 * prefixes (exact for "/" and "/history" etc, prefix for "/domain/").
 * This blocks open-redirect via push payloads carrying absolute URLs or
 * arbitrary paths and is mirrored in client/src/lib/notification-deeplink.ts.
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

function sanitizePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  // Reject anything that smells like an absolute URL or protocol-relative.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return '/';
  if (!raw.startsWith('/')) return '/';
  // Strip query/hash for the allowlist check; preserve them on success.
  const pathOnly = raw.split(/[?#]/, 1)[0];
  if (DEEPLINK_EXACT.has(pathOnly)) return raw;
  for (const prefix of DEEPLINK_PREFIXES) {
    if (pathOnly.startsWith(prefix) && pathOnly.length > prefix.length) return raw;
  }
  return '/';
}

/**
 * Resolve the deep-link path for a TriggerType. Mirrors the routing
 * table documented in the C4.4 plan. Any payload-supplied deepLink is
 * passed through sanitizePath so an external URL in a push payload
 * cannot trick us into navigating off-origin.
 */
function resolveDeepLink(payload) {
  if (payload && typeof payload.deepLink === 'string') {
    return sanitizePath(payload.deepLink);
  }
  const type = payload && payload.type;
  const domain = payload && payload.domain;
  switch (type) {
    case 'ESCALATION_CHANGE':
    case 'ESCALATION_RECOVERY':
    case 'INACTIVITY':
      return '/';
    case 'COMPLIANCE_WARNING':
    case 'DEVIATION_ENDING':
    case 'OVERACHIEVEMENT_SUSTAINED':
      return domain && typeof domain === 'string' && /^[a-z-]{1,32}$/.test(domain)
        ? `/domain/${encodeURIComponent(domain)}`
        : '/';
    case 'RAMP_UP_MILESTONE':
      return '/history';
    default:
      return '/';
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    // Non-JSON payload — fall back to plain text body.
    payload = { title: 'SRE-of-Me', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'SRE-of-Me';
  const options = {
    body: payload.body || '',
    icon: '/favicon.png',
    badge: '/favicon.png',
    tag: payload.id || payload.type || 'sre-of-me',
    data: {
      ...payload,
      deepLink: resolveDeepLink(payload),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.deepLink) || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const origin = self.location.origin;
      for (const client of allClients) {
        try {
          const url = new URL(client.url);
          if (url.origin === origin) {
            await client.focus();
            // Use a postMessage so the SPA can navigate without a full reload.
            client.postMessage({ type: 'notification-click', path: target });
            return;
          }
        } catch {
          /* ignore malformed URLs */
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow(target);
      }
    })()
  );
});
