/**
 * Tests for notification deep-link sanitization and routing
 * (client/src/lib/notification-deeplink.ts).
 *
 * Locks down the same-origin allowlist that gates push-payload deep-links
 * so an attacker can't craft a payload that opens an arbitrary external
 * URL or off-allowlist app route via the notification flow.
 */

import { describe, expect, it } from 'vitest';
import {
  deepLinkForTrigger,
  sanitizeDeepLinkPath,
  triggerToNotificationPayload,
  type MinimalTriggerEvent,
} from './notification-deeplink';

describe('sanitizeDeepLinkPath — rejects unsafe inputs', () => {
  it('rejects non-string input', () => {
    expect(sanitizeDeepLinkPath(undefined)).toBe('/');
    expect(sanitizeDeepLinkPath(null)).toBe('/');
    expect(sanitizeDeepLinkPath(42)).toBe('/');
    expect(sanitizeDeepLinkPath({})).toBe('/');
  });

  it('rejects empty strings', () => {
    expect(sanitizeDeepLinkPath('')).toBe('/');
  });

  it('rejects absolute http/https URLs', () => {
    expect(sanitizeDeepLinkPath('https://evil.example.com/domain/fitness')).toBe('/');
    expect(sanitizeDeepLinkPath('http://evil.example.com/')).toBe('/');
  });

  it('rejects javascript: and data: pseudo-URLs', () => {
    expect(sanitizeDeepLinkPath('javascript:alert(1)')).toBe('/');
    expect(sanitizeDeepLinkPath('JAVASCRIPT:alert(1)')).toBe('/');
    expect(sanitizeDeepLinkPath('data:text/html,<script>alert(1)</script>')).toBe('/');
    expect(sanitizeDeepLinkPath('vbscript:msgbox(1)')).toBe('/');
  });

  it('rejects protocol-relative URLs', () => {
    expect(sanitizeDeepLinkPath('//evil.example.com/path')).toBe('/');
  });

  it('rejects paths that do not start with a forward slash', () => {
    expect(sanitizeDeepLinkPath('domain/fitness')).toBe('/');
    expect(sanitizeDeepLinkPath('history')).toBe('/');
  });

  it('rejects off-allowlist app paths like /admin', () => {
    expect(sanitizeDeepLinkPath('/admin')).toBe('/');
    expect(sanitizeDeepLinkPath('/api/secrets')).toBe('/');
    expect(sanitizeDeepLinkPath('/totally-not-a-route')).toBe('/');
  });

  it('rejects bare /domain/ (prefix matched but no name segment)', () => {
    expect(sanitizeDeepLinkPath('/domain/')).toBe('/');
  });

  it('rejects /domain with no trailing slash (not on the allowlist)', () => {
    expect(sanitizeDeepLinkPath('/domain')).toBe('/');
  });

  it('rejects look-alike paths that are prefixes of allowlisted routes', () => {
    expect(sanitizeDeepLinkPath('/historyx')).toBe('/');
    expect(sanitizeDeepLinkPath('/settings/secret')).toBe('/');
  });
});

describe('sanitizeDeepLinkPath — accepts allowlisted inputs', () => {
  it('accepts dashboard root', () => {
    expect(sanitizeDeepLinkPath('/')).toBe('/');
  });

  it('accepts /history', () => {
    expect(sanitizeDeepLinkPath('/history')).toBe('/history');
  });

  it('accepts /history with a query string', () => {
    expect(sanitizeDeepLinkPath('/history?range=30')).toBe('/history?range=30');
  });

  it('accepts /history with a hash fragment', () => {
    expect(sanitizeDeepLinkPath('/history#week-2')).toBe('/history#week-2');
  });

  it('accepts /domain/<name> for any non-empty name', () => {
    expect(sanitizeDeepLinkPath('/domain/fitness')).toBe('/domain/fitness');
    expect(sanitizeDeepLinkPath('/domain/martial-arts')).toBe('/domain/martial-arts');
    expect(sanitizeDeepLinkPath('/domain/meditation?from=push')).toBe(
      '/domain/meditation?from=push',
    );
  });

  it('accepts other allowlisted exact paths', () => {
    expect(sanitizeDeepLinkPath('/settings')).toBe('/settings');
    expect(sanitizeDeepLinkPath('/system-health')).toBe('/system-health');
    expect(sanitizeDeepLinkPath('/decide')).toBe('/decide');
    expect(sanitizeDeepLinkPath('/log')).toBe('/log');
  });
});

describe('deepLinkForTrigger — routes each trigger type to the correct surface', () => {
  const base: Omit<MinimalTriggerEvent, 'type'> = {
    id: 'evt-1',
    severity: 'ADVISORY',
    title: 't',
    body: 'b',
  };

  it('routes ESCALATION_CHANGE / ESCALATION_RECOVERY / INACTIVITY to the dashboard', () => {
    expect(deepLinkForTrigger({ ...base, type: 'ESCALATION_CHANGE' })).toBe('/');
    expect(deepLinkForTrigger({ ...base, type: 'ESCALATION_RECOVERY' })).toBe('/');
    expect(deepLinkForTrigger({ ...base, type: 'INACTIVITY' })).toBe('/');
  });

  it('routes RAMP_UP_MILESTONE to /history', () => {
    expect(deepLinkForTrigger({ ...base, type: 'RAMP_UP_MILESTONE' })).toBe('/history');
  });

  it('routes domain-scoped triggers to /domain/<name> when domain is present', () => {
    expect(
      deepLinkForTrigger({ ...base, type: 'COMPLIANCE_WARNING', domain: 'fitness' }),
    ).toBe('/domain/fitness');
    expect(
      deepLinkForTrigger({ ...base, type: 'DEVIATION_ENDING', domain: 'meditation' }),
    ).toBe('/domain/meditation');
    expect(
      deepLinkForTrigger({
        ...base,
        type: 'OVERACHIEVEMENT_SUSTAINED',
        domain: 'martial-arts',
      }),
    ).toBe('/domain/martial-arts');
  });

  it('falls back to dashboard for domain-scoped triggers missing a domain', () => {
    expect(deepLinkForTrigger({ ...base, type: 'COMPLIANCE_WARNING' })).toBe('/');
    expect(deepLinkForTrigger({ ...base, type: 'DEVIATION_ENDING' })).toBe('/');
    expect(deepLinkForTrigger({ ...base, type: 'OVERACHIEVEMENT_SUSTAINED' })).toBe('/');
  });
});

describe('triggerToNotificationPayload — flattens engine event into store payload', () => {
  it('preserves identifying fields and attaches the resolved deep link', () => {
    const event: MinimalTriggerEvent = {
      id: 'evt-99',
      type: 'COMPLIANCE_WARNING',
      severity: 'WARNING',
      title: 'Fitness compliance warning',
      body: 'Burn-rate too high.',
      domain: 'fitness',
    };
    expect(triggerToNotificationPayload(event)).toEqual({
      id: 'evt-99',
      type: 'COMPLIANCE_WARNING',
      severity: 'WARNING',
      title: 'Fitness compliance warning',
      body: 'Burn-rate too high.',
      domain: 'fitness',
      deepLink: '/domain/fitness',
    });
  });
});
