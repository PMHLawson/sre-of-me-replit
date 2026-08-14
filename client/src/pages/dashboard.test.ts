/**
 * SOMR-330 — Dashboard consolidation: focused tests for the presentational
 * ConsolidatedDomainCard and the sortedDomains utility.
 *
 * Test environment is Node (no jsdom). ConsolidatedDomainCard is purely
 * presentational (no hooks) so renderToStaticMarkup works without mocking.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  sortedDomains,
  CONFIGURED_DOMAIN_ORDER,
  ConsolidatedDomainCard,
} from './dashboard';
import type { Domain, DomainStatus } from '@/store';
import type { DomainEscalation, EscalationTier } from '@shared/schema';

// ─── Fixture factories ────────────────────────────────────────────────────────

const makeDomainStatus = (overrides: Partial<DomainStatus> = {}): DomainStatus => ({
  score: 75,
  trend: 'flat',
  status: 'healthy',
  recentMinutes: 80,
  targetMinutes: 105,
  previousWeekMinutes: 80,
  sessionFloor: 15,
  cadence: 'Daily',
  overachievementRaw: 100,
  overachievementTier: 'NONE',
  ...overrides,
});

const makeEsc = (
  domain: Domain,
  tier: EscalationTier,
  overrides: Partial<DomainEscalation> = {},
): DomainEscalation => ({
  domain,
  tier,
  rationale: `${tier} rationale for ${domain}`,
  recommendedAction: `${tier} action for ${domain}`,
  consecutiveLowDays: 0,
  burnRate: 1.0,
  errorBudget: {
    consumedMinutes: 0,
    allowedMinutes: 63,
    remainingMinutes: 63,
    percentRemaining: 100,
  },
  ...overrides,
});

// ─── sortedDomains ────────────────────────────────────────────────────────────

describe('sortedDomains — one card per domain', () => {
  it('returns exactly four entries, one per domain', () => {
    const result = sortedDomains(CONFIGURED_DOMAIN_ORDER, {});
    expect(result).toHaveLength(4);
  });

  it('contains exactly the four configured domains (no duplicates)', () => {
    const result = sortedDomains(CONFIGURED_DOMAIN_ORDER, {});
    const unique = new Set(result);
    expect(unique.size).toBe(4);
    for (const d of CONFIGURED_DOMAIN_ORDER) {
      expect(unique.has(d)).toBe(true);
    }
  });
});

describe('sortedDomains — severity ordering', () => {
  it('places the highest-severity domain first', () => {
    const perDomain = {
      'martial-arts': makeEsc('martial-arts', 'NOMINAL'),
      'meditation':   makeEsc('meditation',   'BREACH'),
      'fitness':      makeEsc('fitness',       'ADVISORY'),
      'music':        makeEsc('music',         'NOMINAL'),
    };
    const result = sortedDomains(CONFIGURED_DOMAIN_ORDER, perDomain);
    expect(result[0]).toBe('meditation');
    expect(result[1]).toBe('fitness');
  });

  it('ranks PAGE > BREACH > WARNING > ADVISORY > NOMINAL', () => {
    const perDomain = {
      'martial-arts': makeEsc('martial-arts', 'ADVISORY'),
      'meditation':   makeEsc('meditation',   'PAGE'),
      'fitness':      makeEsc('fitness',       'WARNING'),
      'music':        makeEsc('music',         'NOMINAL'),
    };
    const result = sortedDomains(CONFIGURED_DOMAIN_ORDER, perDomain);
    expect(result).toEqual(['meditation', 'fitness', 'martial-arts', 'music']);
  });

  it('treats a missing perDomain entry as NOMINAL', () => {
    // Only meditation has an entry; the rest fall back to NOMINAL
    const perDomain: Partial<Record<Domain, DomainEscalation>> = {
      'meditation': makeEsc('meditation', 'PAGE'),
    };
    const result = sortedDomains(CONFIGURED_DOMAIN_ORDER, perDomain);
    expect(result[0]).toBe('meditation');
  });

  it('handles undefined perDomain — falls back to configured order', () => {
    const result = sortedDomains(CONFIGURED_DOMAIN_ORDER, undefined);
    expect(result).toEqual([...CONFIGURED_DOMAIN_ORDER]);
  });
});

describe('sortedDomains — stable tie-break uses configured domain order', () => {
  it('preserves configured order when all tiers are identical', () => {
    const perDomain = Object.fromEntries(
      CONFIGURED_DOMAIN_ORDER.map(d => [d, makeEsc(d as Domain, 'NOMINAL')]),
    ) as Record<Domain, DomainEscalation>;
    const result = sortedDomains(CONFIGURED_DOMAIN_ORDER, perDomain);
    expect(result).toEqual([...CONFIGURED_DOMAIN_ORDER]);
  });

  it('within equal tiers, preserves martial-arts before meditation, fitness before music', () => {
    const perDomain = {
      'martial-arts': makeEsc('martial-arts', 'WARNING'),
      'meditation':   makeEsc('meditation',   'WARNING'),
      'fitness':      makeEsc('fitness',       'NOMINAL'),
      'music':        makeEsc('music',         'NOMINAL'),
    };
    const result = sortedDomains(CONFIGURED_DOMAIN_ORDER, perDomain);
    // Both WARNING domains come first; configured order = martial-arts before meditation
    expect(result[0]).toBe('martial-arts');
    expect(result[1]).toBe('meditation');
    // Both NOMINAL domains follow; configured order = fitness before music
    expect(result[2]).toBe('fitness');
    expect(result[3]).toBe('music');
  });
});

// ─── ConsolidatedDomainCard helpers ──────────────────────────────────────────

const renderCard = (
  domain: Domain,
  domainStatus: DomainStatus,
  esc: DomainEscalation | undefined,
  isRampUp = false,
): string =>
  renderToStaticMarkup(
    React.createElement(ConsolidatedDomainCard, {
      domain,
      domainStatus,
      esc,
      isRampUp,
      onClick: () => {},
    }),
  );

// ─── ConsolidatedDomainCard — one card per domain ────────────────────────────

describe('ConsolidatedDomainCard — one card per domain', () => {
  it('renders exactly one element with the domain data-testid', () => {
    const html = renderCard('meditation', makeDomainStatus(), makeEsc('meditation', 'NOMINAL'));
    const matches = html.match(/data-testid="card-domain-meditation"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('each domain renders a unique testid', () => {
    for (const domain of CONFIGURED_DOMAIN_ORDER) {
      const html = renderCard(domain, makeDomainStatus(), makeEsc(domain, 'NOMINAL'));
      expect(html).toContain(`data-testid="card-domain-${domain}"`);
    }
  });
});

// ─── ConsolidatedDomainCard — server-tier-driven styling and labels ───────────

describe('ConsolidatedDomainCard — server-tier-driven styling', () => {
  it('renders the server-supplied tier label, not a locally-computed value', () => {
    const html = renderCard('fitness', makeDomainStatus(), makeEsc('fitness', 'BREACH'));
    expect(html).toContain('data-testid="card-domain-fitness-tier"');
    expect(html).toContain('BREACH');
  });

  it('BREACH tier applies critical color classes to the card and badge', () => {
    const html = renderCard('music', makeDomainStatus(), makeEsc('music', 'BREACH'));
    expect(html).toContain('text-status-critical');
    expect(html).toContain('bg-status-critical');
  });

  it('NOMINAL tier applies healthy color classes to the card and badge', () => {
    const html = renderCard('meditation', makeDomainStatus(), makeEsc('meditation', 'NOMINAL'));
    expect(html).toContain('text-status-healthy');
    expect(html).toContain('bg-status-healthy');
  });

  it('WARNING tier applies degraded color classes', () => {
    const html = renderCard('martial-arts', makeDomainStatus(), makeEsc('martial-arts', 'WARNING'));
    expect(html).toContain('text-status-degraded');
    expect(html).toContain('bg-status-degraded');
  });

  it('ADVISORY tier applies advisory color classes', () => {
    const html = renderCard('fitness', makeDomainStatus(), makeEsc('fitness', 'ADVISORY'));
    expect(html).toContain('text-status-advisory');
    expect(html).toContain('bg-status-advisory');
  });

  it('PAGE tier applies critical color classes (same visual treatment as BREACH)', () => {
    const html = renderCard('music', makeDomainStatus(), makeEsc('music', 'PAGE'));
    expect(html).toContain('text-status-critical');
    expect(html).toContain('bg-status-critical');
  });

  it('renders neutral bg-card styling when esc is undefined (loading state)', () => {
    const html = renderCard('fitness', makeDomainStatus(), undefined);
    expect(html).toContain('bg-card');
    // Must not apply any tier-specific critical color
    expect(html).not.toContain('text-status-critical');
    expect(html).not.toContain('bg-status-critical');
  });
});

// ─── ConsolidatedDomainCard — server error-budget display ────────────────────

describe('ConsolidatedDomainCard — server error-budget display', () => {
  it('renders the server-supplied budget percentage', () => {
    const esc = makeEsc('music', 'ADVISORY', {
      errorBudget: {
        consumedMinutes: 20,
        allowedMinutes: 27,
        remainingMinutes: 7,
        percentRemaining: 26,
      },
    });
    const html = renderCard('music', makeDomainStatus(), esc);
    expect(html).toContain('data-testid="card-domain-music-budget"');
    expect(html).toContain('26%');
  });

  it('does not render a budget element when esc is undefined', () => {
    const html = renderCard('fitness', makeDomainStatus(), undefined);
    expect(html).not.toContain('data-testid="card-domain-fitness-budget"');
  });
});

// ─── ConsolidatedDomainCard — live configured thresholds ─────────────────────

describe('ConsolidatedDomainCard — live configured thresholds', () => {
  it('renders the configured target minutes from domainStatus', () => {
    const html = renderCard(
      'martial-arts',
      makeDomainStatus({ targetMinutes: 105, recentMinutes: 60 }),
      makeEsc('martial-arts', 'NOMINAL'),
    );
    expect(html).toContain('105m');
  });

  it('renders the configured session floor from domainStatus', () => {
    const html = renderCard(
      'martial-arts',
      makeDomainStatus({ sessionFloor: 15 }),
      makeEsc('martial-arts', 'NOMINAL'),
    );
    expect(html).toContain('data-testid="card-domain-martial-arts-floor"');
    expect(html).toContain('Floor 15m');
  });

  it('renders the configured cadence from domainStatus', () => {
    const html = renderCard(
      'fitness',
      makeDomainStatus({ cadence: '6×/week' }),
      makeEsc('fitness', 'NOMINAL'),
    );
    expect(html).toContain('data-testid="card-domain-fitness-cadence"');
    expect(html).toContain('6×/week');
  });

  it('renders 3×/week cadence for music (distinct from fitness)', () => {
    const html = renderCard(
      'music',
      makeDomainStatus({ cadence: '3×/week' }),
      makeEsc('music', 'NOMINAL'),
    );
    expect(html).toContain('3×/week');
  });

  it('renders the server rationale, not a hard-coded string', () => {
    const esc = makeEsc('meditation', 'WARNING');
    const html = renderCard('meditation', makeDomainStatus(), esc);
    expect(html).toContain('data-testid="card-domain-meditation-rationale"');
    expect(html).toContain(esc.rationale);
  });

  it('renders the server recommended action', () => {
    const esc = makeEsc('meditation', 'WARNING');
    const html = renderCard('meditation', makeDomainStatus(), esc);
    expect(html).toContain('data-testid="card-domain-meditation-action"');
    expect(html).toContain(esc.recommendedAction);
  });
});

// ─── ConsolidatedDomainCard — navigation ─────────────────────────────────────

describe('ConsolidatedDomainCard — navigation', () => {
  it('card root element has the domain data-testid for click-target identification', () => {
    for (const domain of CONFIGURED_DOMAIN_ORDER) {
      const html = renderCard(domain, makeDomainStatus(), makeEsc(domain, 'NOMINAL'));
      expect(html).toContain(`data-testid="card-domain-${domain}"`);
    }
  });

  it('card is rendered as a clickable div (not a non-interactive element)', () => {
    const html = renderCard('meditation', makeDomainStatus(), makeEsc('meditation', 'NOMINAL'));
    // The outer element should be a div (not span or p) with cursor-pointer
    expect(html).toContain('cursor-pointer');
  });
});

// ─── ConsolidatedDomainCard — mobile-safe structure ──────────────────────────

describe('ConsolidatedDomainCard — mobile-safe structure', () => {
  it('contains flex-wrap so content reflows on narrow viewports', () => {
    const html = renderCard('music', makeDomainStatus(), makeEsc('music', 'NOMINAL'));
    expect(html).toContain('flex-wrap');
  });

  it('contains min-w-0 to allow text truncation without overflow', () => {
    const html = renderCard('music', makeDomainStatus(), makeEsc('music', 'NOMINAL'));
    expect(html).toContain('min-w-0');
  });

  it('does not contain inline fixed pixel widths that force horizontal scroll', () => {
    const html = renderCard('music', makeDomainStatus(), makeEsc('music', 'NOMINAL'));
    // No style attribute containing a 3-digit-or-more pixel width
    const fixedWidths = html.match(/style="[^"]*width:\s*\d{3,}px/g) ?? [];
    expect(fixedWidths).toHaveLength(0);
  });

  it('does not contain overflow-x-auto or overflow-x-scroll wrappers', () => {
    const html = renderCard('music', makeDomainStatus(), makeEsc('music', 'NOMINAL'));
    expect(html).not.toContain('overflow-x-auto');
    expect(html).not.toContain('overflow-x-scroll');
  });
});

// ─── ConsolidatedDomainCard — ramp-up annotation ─────────────────────────────

describe('ConsolidatedDomainCard — ramp-up annotation', () => {
  it('renders the ramp-up notice when isRampUp is true', () => {
    const html = renderCard(
      'martial-arts',
      makeDomainStatus(),
      makeEsc('martial-arts', 'NOMINAL'),
      true,
    );
    expect(html).toContain('data-testid="card-domain-martial-arts-rampup"');
  });

  it('does not render the ramp-up notice when isRampUp is false', () => {
    const html = renderCard(
      'martial-arts',
      makeDomainStatus(),
      makeEsc('martial-arts', 'NOMINAL'),
      false,
    );
    expect(html).not.toContain('data-testid="card-domain-martial-arts-rampup"');
  });
});

// ─── EscalationTimeline on Dashboard ─────────────────────────────────────────
// These tests prove the composite timeline component renders correctly in the
// same node/renderToStaticMarkup environment used by the Dashboard.
// EscalationTimeline is purely presentational (no hooks) and is consumed by
// the Dashboard in composite mode (no `domain` prop).

import { EscalationTimeline } from '@/components/escalation-surface';
import type { EscalationHistoryEntry } from '@shared/schema';
import * as fs from 'fs';
import * as path from 'path';

const makeHistory = (n: number, tier: EscalationTier = 'NOMINAL'): EscalationHistoryEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    logical_day: `2026-07-${String(i + 1).padStart(2, '0')}`,
    highestTier: tier,
    perDomain: {
      'martial-arts': { tier, percentRemaining: 80 },
      meditation:     { tier, percentRemaining: 80 },
      fitness:        { tier, percentRemaining: 80 },
      music:          { tier, percentRemaining: 80 },
    },
  }));

describe('Dashboard — composite EscalationTimeline present', () => {
  it('renders a composite timeline wrapper with the dashboard-tier-timeline testid', () => {
    // Simulate what the Dashboard renders for the timeline block:
    // <EscalationTimeline history={history} />  (no domain prop → composite)
    const html = renderToStaticMarkup(
      React.createElement(EscalationTimeline, { history: makeHistory(7) }),
    );
    // The composite testid suffix is "composite" when no domain is passed
    expect(html).toContain('data-testid="escalation-timeline-composite"');
  });

  it('renders one cell per history day', () => {
    const days = 14;
    const html = renderToStaticMarkup(
      React.createElement(EscalationTimeline, { history: makeHistory(days) }),
    );
    const cells = html.match(/data-testid="escalation-timeline-cell-composite-/g) ?? [];
    expect(cells).toHaveLength(days);
  });

  it('renders a BREACH cell with the correct data-tier attribute', () => {
    const history = makeHistory(7, 'BREACH');
    const html = renderToStaticMarkup(
      React.createElement(EscalationTimeline, { history }),
    );
    expect(html).toContain('data-tier="BREACH"');
  });

  it('renders nothing when history is empty', () => {
    const html = renderToStaticMarkup(
      React.createElement(EscalationTimeline, { history: [] }),
    );
    expect(html).toBe('');
  });

  it('renders the trend note for a steady NOMINAL history', () => {
    const html = renderToStaticMarkup(
      React.createElement(EscalationTimeline, { history: makeHistory(7) }),
    );
    expect(html).toContain('data-testid="escalation-timeline-trend-composite"');
    expect(html).toContain('Steady at NOMINAL');
  });
});

// ─── Dashboard — EscalationStrip absent ──────────────────────────────────────
// Regression guard: the old duplicate domain-button list must not reappear.
// Checked via source text so the assertion survives future component refactors
// that might accidentally re-import the orphaned EscalationStrip.

describe('Dashboard — EscalationStrip absent', () => {
  const dashboardSource = fs.readFileSync(
    path.resolve(__dirname, 'dashboard.tsx'),
    'utf8',
  );

  it('dashboard.tsx does not render EscalationStrip', () => {
    // Allow the identifier to appear in comments but not as a JSX element
    // or component invocation. A bare import is also a violation signal.
    expect(dashboardSource).not.toMatch(/<EscalationStrip[\s/>]/);
  });

  it('dashboard.tsx does not import EscalationStrip', () => {
    expect(dashboardSource).not.toMatch(/import[^;]*EscalationStrip/);
  });

  it('dashboard.tsx does render EscalationTimeline (the retained historical reference)', () => {
    expect(dashboardSource).toContain('EscalationTimeline');
  });

  it('dashboard.tsx contains the dashboard-tier-timeline testid wrapper', () => {
    expect(dashboardSource).toContain('data-testid="dashboard-tier-timeline"');
  });
});
