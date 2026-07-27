/**
 * Regression test for SOMR-323: Activity History chart renders an empty SVG
 * when Recharts children are passed as a JSX Fragment variable.
 *
 * Empirically verified: Recharts 2.15.4 silently drops all children when the
 * single child of BarChart is a React.Fragment element. Passing children as a
 * keyed array (or directly) produces correct output.
 *
 * This test renders ChartBars via renderToStaticMarkup (SSR) exercising the
 * fixed-width branch (needsScroll=true) and asserts that bar rectangles and
 * cartesian axis elements are present in the output.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartBars } from './domain-detail';

const SAMPLE_DATA = [
  {
    dateKey: '2026-07-20',
    dayLabel: 'M1',
    fullDate: 'Jul 20',
    minutes: 25,
    isToday: false,
    tier: 'older' as const,
    hasAnomaly: false,
    hasDeviation: false,
  },
  {
    dateKey: '2026-07-21',
    dayLabel: 'T2',
    fullDate: 'Jul 21',
    minutes: 40,
    isToday: false,
    tier: 'previous' as const,
    hasAnomaly: false,
    hasDeviation: false,
  },
  {
    dateKey: '2026-07-26',
    dayLabel: 'S3',
    fullDate: 'Jul 26',
    minutes: 0,
    isToday: true,
    tier: 'current' as const,
    hasAnomaly: false,
    hasDeviation: false,
  },
];

describe('ChartBars — fixed-width branch (needsScroll=true)', () => {
  it('renders bar rectangles and axis elements (not an empty SVG)', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChartBars, {
        data: SAMPLE_DATA,
        accentHex: '#6B8EC4',
        needsScroll: true,
        fixedWidth: 600,
        height: 180,
        viewDays: 42,
        policyDailyProRate: 10,
        policySessionFloor: 10,
        getBarOpacity: (_tier: string) => 1,
      }),
    );

    const barRects = (html.match(/recharts-bar-rectangle/g) ?? []).length;
    const axisEls  = (html.match(/recharts-cartesian-axis/g) ?? []).length;

    expect(barRects, 'recharts-bar-rectangle count must be > 0').toBeGreaterThan(0);
    expect(axisEls,  'recharts-cartesian-axis count must be > 0').toBeGreaterThan(0);
  });
});
