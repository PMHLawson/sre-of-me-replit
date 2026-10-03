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
import type { ChartDatum } from '@/lib/domain-detail-aggregation';

const SAMPLE_DATA: ChartDatum[] = [
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
    isToday: false,
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
        yAxisTicks: [0, 20, 40],
        yAxisWidth: 40,
        yDomainMax: 50,
        getBarOpacity: (_tier: string) => 1,
      }),
    );

    const barRects = (html.match(/recharts-bar-rectangle/g) ?? []).length;
    const axisEls  = (html.match(/recharts-cartesian-axis/g) ?? []).length;

    expect(barRects, 'recharts-bar-rectangle count must be > 0').toBeGreaterThan(0);
    expect(axisEls,  'recharts-cartesian-axis count must be > 0').toBeGreaterThan(0);
  });
  const render = (data: ChartDatum[], max = 50) => renderToStaticMarkup(
    React.createElement(ChartBars, {
      data, accentHex: '#7A6FD6', needsScroll: true, fixedWidth: 600,
      height: 180, viewDays: 14, policyDailyProRate: 6, policySessionFloor: 15,
      yAxisTicks: [0, max / 2, max], yAxisWidth: 40, yDomainMax: max,
      getBarOpacity: () => 1,
    }),
  );
  it('renders exactly one circle for a flagged day and keeps its amber outline', () => {
    const html = render(SAMPLE_DATA.map((d, i) => ({ ...d, hasAnomaly: i === 1 })));
    expect((html.match(/data-testid="chart-anomaly-marker"/g) ?? []).length).toBe(1);
    expect(html).toContain('stroke="#E2B23E"');
    expect(html).toContain('pointer-events="none"');
  });
  it('removes every circle when the next range/domain has no flagged days', () => {
    expect(render(SAMPLE_DATA)).not.toContain('data-testid="chart-anomaly-marker"');
  });
  it('keeps a highest-bar circle fully inside the SVG top boundary', () => {
    const html = render(SAMPLE_DATA.map((d, i) => ({ ...d, minutes: i === 0 ? 200 : d.minutes, hasAnomaly: i === 0 })), 230);
    const circle = html.match(/<circle[^>]*data-testid="chart-anomaly-marker"[^>]*>/)?.[0];
    expect(circle).toBeDefined();
    const cy = Number(circle?.match(/cy="([^"]+)"/)?.[1]);
    expect(cy - 3).toBeGreaterThan(0);
  });
  it('renders both Music thresholds inside the empty plotting region', () => {
    const html = render(SAMPLE_DATA.map(d => ({ ...d, minutes: 0 })), 20);
    const lines = (html.match(/<line[^>]*recharts-reference-line-line[^>]*>/g) ?? [])
      .map(line => Number(line.match(/y1="([^"]+)"/)?.[1]));
    expect(lines).toHaveLength(2);
    expect(lines).toContain(53); // 15m on the explicit 0..20 presentation scale.
    expect(lines).toContain(116); // 6m on the same scale.
    expect(lines.every(y => y >= 18 && y <= 158)).toBe(true);
  });
});
