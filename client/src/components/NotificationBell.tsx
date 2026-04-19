/**
 * NotificationBell — C4.3 in-app notification surface.
 *
 * Renders a bell icon in the dashboard header with an unread-count badge.
 * Clicking opens a popover listing recent triggered events from the
 * Zustand store (`pendingNotifications`). Each row is a deep-link
 * target: clicking navigates via wouter to the event's `deepLink`
 * and marks it read.
 *
 * If the browser supports Notifications and permission is `default`,
 * the popover shows a one-tap "Enable notifications" prompt that calls
 * `requestNotificationPermission()`.
 */

import { useState } from 'react';
import { useLocation } from 'wouter';
import { Bell, BellOff } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';
import { sanitizeDeepLinkPath } from '@/lib/notification-deeplink';

const SEVERITY_DOT: Record<string, string> = {
  ADVISORY: 'bg-yellow-400',
  WARNING: 'bg-orange-500',
  BREACH: 'bg-red-500',
  PAGE: 'bg-purple-500',
};

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function NotificationBell() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const notifications = useAppStore((s) => s.pendingNotifications);
  const markRead = useAppStore((s) => s.markNotificationRead);
  const clearAll = useAppStore((s) => s.clearPendingNotifications);
  const permission = useAppStore((s) => s.notificationPermission);
  const requestPermission = useAppStore((s) => s.requestNotificationPermission);
  const isSnoozed = useAppStore((s) => s.isSnoozed);
  const setSnooze = useAppStore((s) => s.setSnoozeUntil);

  const unread = notifications.filter((n) => !n.read).length;
  const snoozed = isSnoozed();

  const handleRowClick = (id: string, deepLink: string) => {
    markRead(id);
    setOpen(false);
    // Stored deepLinks already pass through the lib helper, but re-sanitize
    // before navigation as defence-in-depth against future store-injection bugs.
    setLocation(sanitizeDeepLinkPath(deepLink));
  };

  const handleSnooze = () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    setSnooze(until);
    // Also drop any unread items so the badge clears immediately.
    clearAll();
  };
  const handleUnsnooze = () => setSnooze(null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative w-10 h-10 rounded-full hover:bg-muted/60 flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Notifications"
          data-testid="button-notifications"
        >
          {snoozed ? (
            <BellOff className="w-4 h-4" />
          ) : (
            <Bell className="w-4 h-4" />
          )}
          {unread > 0 && !snoozed && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center"
              data-testid="badge-notification-count"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-0"
        data-testid="popover-notifications"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-semibold">Notifications</span>
          {notifications.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="button-clear-notifications"
            >
              Clear all
            </button>
          )}
        </div>

        {permission === 'default' && (
          <div className="px-3 py-2 border-b bg-muted/40">
            <p className="text-xs text-muted-foreground mb-2">
              Enable browser notifications to be alerted when escalation
              changes happen while the app is closed.
            </p>
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs"
              onClick={() => requestPermission()}
              data-testid="button-enable-notifications"
            >
              Enable notifications
            </Button>
          </div>
        )}

        {permission === 'denied' && (
          <div
            className="px-3 py-2 border-b bg-muted/40 text-xs text-muted-foreground"
            data-testid="text-permission-denied"
          >
            Browser notifications are blocked. Enable them in your browser
            settings to receive alerts when the app is closed.
          </div>
        )}

        <div className="max-h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <div
              className="px-3 py-6 text-center text-xs text-muted-foreground"
              data-testid="text-no-notifications"
            >
              No notifications yet.
            </div>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => handleRowClick(n.id, n.deepLink)}
                className={`w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-muted/40 transition-colors flex gap-2 ${
                  n.read ? 'opacity-60' : ''
                }`}
                data-testid={`notification-${n.id}`}
              >
                <span
                  className={`mt-1 inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                    SEVERITY_DOT[n.severity] || 'bg-muted'
                  }`}
                  aria-label={n.severity}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold truncate">
                      {n.title}
                    </span>
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">
                      {formatRelative(n.receivedAt)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {n.body}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>

        <div className="px-3 py-2 border-t flex items-center justify-between">
          {snoozed ? (
            <button
              type="button"
              onClick={handleUnsnooze}
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="button-unsnooze"
            >
              Resume notifications
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSnooze}
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="button-snooze-1h"
            >
              Snooze 1 hour
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setLocation('/settings');
            }}
            className="text-xs text-muted-foreground hover:text-foreground"
            data-testid="link-notification-settings"
          >
            Settings
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
