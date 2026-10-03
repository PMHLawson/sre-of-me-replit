import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Router } from 'wouter';

const testState = vi.hoisted(() => ({
  current: {
    rampUp: false,
  },
}));

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: any) => unknown) => selector({
    getDomainStatus: () => ({
      score: 73,
      trend: 'flat',
      status: 'healthy',
      recentMinutes: 84,
      targetMinutes: 105,
      previousWeekMinutes: 84,
      sessionFloor: 15,
      cadence: 'Daily',
      overachievementRaw: 100,
      overachievementTier: 'NONE',
    }),
    sessions: [],
    sessionsLoaded: true,
    escalationStateLoaded: true,
    policyState: {},
    escalationState: {
      isRampUp: testState.current.rampUp,
      perDomain: Object.fromEntries(
        ['martial-arts', 'meditation', 'fitness', 'music'].map(domain => [
          domain,
          {
            domain,
            tier: 'NOMINAL',
            rationale: `Test rationale for ${domain}`,
            recommendedAction: `Test action for ${domain}`,
            consecutiveLowDays: 0,
            burnRate: 1,
            errorBudget: {
              consumedMinutes: 0,
              allowedMinutes: 63,
              remainingMinutes: 63,
              percentRemaining: 100,
            },
          },
        ]),
      ),
      composite: {
        displayStatus: 'NOMINAL',
        rationale: 'Test system-health rationale.',
      },
      history: [],
    },
  }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: null, logout: vi.fn() }),
}));

vi.mock('@/components/theme-toggle', () => ({
  ThemeToggle: () => null,
}));

vi.mock('@/components/NotificationBell', () => ({
  NotificationBell: () => null,
}));

vi.mock('@/components/escalation-surface', () => ({
  TIER_STYLE: {
    NOMINAL: { Icon: () => null, bg: 'bg-nominal', border: 'border-nominal', text: 'text-nominal' },
    ADVISORY: { Icon: () => null, bg: 'bg-advisory', border: 'border-advisory', text: 'text-advisory' },
    WARNING: { Icon: () => null, bg: 'bg-warning', border: 'border-warning', text: 'text-warning' },
    BREACH: { Icon: () => null, bg: 'bg-breach', border: 'border-breach', text: 'text-breach' },
    PAGE: { Icon: () => null, bg: 'bg-page', border: 'border-page', text: 'text-page' },
  },
  TIER_RANK: { NOMINAL: 0, ADVISORY: 1, WARNING: 2, BREACH: 3, PAGE: 4 },
  EscalationTimeline: () => null,
}));

vi.mock('@/components/overachievement-badge', () => ({
  OverachievementBadge: () => null,
}));

vi.mock('@/components/deviations/deviation-section', () => ({
  DeviationSection: () => null,
}));

import Dashboard from './dashboard';

const domains = [
  ['martial-arts', 'Martial Arts'],
  ['meditation', 'Meditation'],
  ['fitness', 'Fitness'],
  ['music', 'Music'],
] as const;

const renderDashboard = (rampUp: boolean) => {
  testState.current.rampUp = rampUp;
  return renderToStaticMarkup(
    React.createElement(
      Router,
      {
        hook: () => ['/', () => {}] as [string, (to: string) => void],
        children: React.createElement(Dashboard),
      },
    ),
  );
};

const renderedAnchor = (html: string, testId: string) =>
  html.match(new RegExp(`<a\\b(?=[^>]*data-testid="${testId}")[^>]*>[\\s\\S]*?<\\/a>`))?.[0];

const assertSingleLink = (markup: string, href: string, name: string) => {
  expect(markup).toMatch(/^<a\b/);
  expect(markup).toContain(`href="${href}"`);
  expect(markup).toContain(`aria-label="${name}"`);
  expect(markup).toContain('focus-visible:outline');
  expect(markup).toContain('focus-visible:outline-offset-');
  expect(markup).toContain('block');
  expect(markup).toContain('scroll-m-2');
  const contents = markup.replace(/^<a\b[^>]*>/, '').replace(/<\/a>$/, '');
  expect(contents).not.toMatch(/<(?:a|button|input|select|textarea)\b/i);
};

describe('Dashboard navigation semantics', () => {
  beforeEach(() => {
    testState.current.rampUp = false;
  });

  it.each(domains)('renders the %s domain card as a named route link', (domain, title) => {
    const html = renderDashboard(false);
    const card = renderedAnchor(html, `card-domain-${domain}`);

    expect(card).toBeDefined();
    assertSingleLink(card!, `/domain/${domain}`, `View ${title}`);
    expect(card).toContain(`data-testid="card-domain-${domain}"`);
    expect(card).toContain(`>${title}<`);
    expect(card).toContain('73/100');
    expect(card).toContain('84m / 105m');
    expect(card).toContain('cursor-pointer');
    expect(card).toContain('active:scale-[0.99]');
    expect(card).toContain(`data-testid="card-domain-${domain}-tier"`);
  });

  it('renders the normal System Health card as a named route link', () => {
    const html = renderDashboard(false);
    const card = renderedAnchor(html, 'card-system-health');

    expect(card).toBeDefined();
    assertSingleLink(card!, '/system-health', 'View System Health');
    expect(card).toContain('System Health');
    expect(card).toContain('Test system-health rationale.');
    expect(card).toContain('hover:bg-accent/30');
    expect(card).toContain('active:scale-[0.98]');
  });

  it('renders the ramp-up System Health card as a named route link', () => {
    const html = renderDashboard(true);
    const card = renderedAnchor(html, 'card-system-health-rampup');

    expect(card).toBeDefined();
    assertSingleLink(card!, '/system-health', 'View System Health');
    expect(card).toContain('System Calibrating');
    expect(card).toContain('RAMP-UP');
    expect(card).toContain('hover:bg-primary/15');
    expect(card).toContain('active:scale-[0.98]');
  });
});