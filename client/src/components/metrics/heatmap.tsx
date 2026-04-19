import { useMemo } from 'react';
import { format, subDays, startOfWeek, parseISO, isSameDay } from 'date-fns';
import type { Session } from '@/store';

interface CalendarHeatMapProps {
  sessions: Session[];
  days: number;
  testIdPrefix?: string;
}

const INTENSITY_TIERS = [
  { min: 0,  opacity: 0.10, label: '0' },
  { min: 1,  opacity: 0.30, label: '1–29m' },
  { min: 30, opacity: 0.55, label: '30–59m' },
  { min: 60, opacity: 0.80, label: '60–89m' },
  { min: 90, opacity: 1.00, label: '90m+' },
];

const tierFor = (minutes: number) => {
  for (let i = INTENSITY_TIERS.length - 1; i >= 0; i--) {
    if (minutes >= INTENSITY_TIERS[i].min) return INTENSITY_TIERS[i];
  }
  return INTENSITY_TIERS[0];
};

const DOW_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function CalendarHeatMap({ sessions, days, testIdPrefix = 'heatmap' }: CalendarHeatMapProps) {
  const { cells, weeks, monthLabels, totalMinutes, activeDays } = useMemo(() => {
    const byDate = new Map<string, number>();
    for (const s of sessions) {
      if (s.deletedAt) continue;
      const key = format(parseISO(s.timestamp), 'yyyy-MM-dd');
      byDate.set(key, (byDate.get(key) ?? 0) + s.durationMinutes);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const earliest = subDays(today, days - 1);
    const gridStart = startOfWeek(earliest, { weekStartsOn: 1 });
    const dayMs = 24 * 60 * 60 * 1000;
    const totalCells = Math.ceil((today.getTime() - gridStart.getTime()) / dayMs) + 1;
    const weekCount = Math.ceil(totalCells / 7);
    const cellCount = weekCount * 7;

    let runningTotal = 0;
    let active = 0;
    const built = Array.from({ length: cellCount }).map((_, i) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + i);
      const key = format(date, 'yyyy-MM-dd');
      const minutes = byDate.get(key) ?? 0;
      const inRange = date >= earliest && date.getTime() <= today.getTime();
      const isToday = isSameDay(date, today);
      const isFuture = date.getTime() > today.getTime();
      if (inRange) {
        runningTotal += minutes;
        if (minutes > 0) active += 1;
      }
      return { date, key, minutes, inRange, isToday, isFuture };
    });

    const labels: { col: number; label: string }[] = [];
    let lastMonth = '';
    for (let c = 0; c < weekCount; c++) {
      const firstCell = built[c * 7];
      const m = format(firstCell.date, 'MMM');
      if (m !== lastMonth) {
        labels.push({ col: c, label: m });
        lastMonth = m;
      }
    }

    return { cells: built, weeks: weekCount, monthLabels: labels, totalMinutes: runningTotal, activeDays: active };
  }, [sessions, days]);

  const cellSize = days <= 14 ? 26 : days <= 30 ? 20 : 14;
  const gap = days <= 30 ? 4 : 2;

  return (
    <div className="space-y-2" data-testid={testIdPrefix}>
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Activity Heat Map
          </div>
          <div className="text-sm font-semibold text-foreground">Last {days} days</div>
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">
          {totalMinutes}m · {activeDays} active day{activeDays === 1 ? '' : 's'}
        </div>
      </div>

      <div className="overflow-x-auto -mx-1 px-1">
        <div className="flex gap-1 items-start" style={{ width: 'fit-content' }}>
          <div
            className="grid text-[9px] font-mono font-medium text-muted-foreground"
            style={{
              gridTemplateRows: `repeat(7, ${cellSize}px)`,
              rowGap: `${gap}px`,
              paddingTop: '14px',
            }}
          >
            {DOW_LABELS.map((d, i) => (
              <span key={i} className="leading-none flex items-center" style={{ height: cellSize }}>
                {i % 2 === 0 ? d : ''}
              </span>
            ))}
          </div>

          <div>
            <div
              className="grid text-[9px] font-mono font-medium text-muted-foreground mb-1"
              style={{
                gridTemplateColumns: `repeat(${weeks}, ${cellSize}px)`,
                columnGap: `${gap}px`,
              }}
            >
              {Array.from({ length: weeks }).map((_, c) => {
                const label = monthLabels.find((l) => l.col === c);
                return (
                  <span key={c} className="truncate" style={{ height: '12px' }}>
                    {label?.label ?? ''}
                  </span>
                );
              })}
            </div>

            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${weeks}, ${cellSize}px)`,
                gridTemplateRows: `repeat(7, ${cellSize}px)`,
                gridAutoFlow: 'column',
                gap: `${gap}px`,
              }}
            >
              {cells.map((cell) => {
                if (cell.isFuture) {
                  return <div key={cell.key} aria-hidden="true" />;
                }
                const tier = tierFor(cell.minutes);
                const showAsEmpty = !cell.inRange;
                const title = `${format(cell.date, 'MMM d, yyyy')} · ${cell.minutes}m`;
                return (
                  <div
                    key={cell.key}
                    className={`rounded-[3px] ${cell.isToday ? 'ring-1 ring-primary ring-offset-0' : ''}`}
                    style={{
                      backgroundColor: showAsEmpty ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
                      opacity: showAsEmpty ? 0.15 : tier.opacity,
                    }}
                    title={title}
                    aria-label={title}
                    data-testid={`${testIdPrefix}-cell-${cell.key}`}
                    data-minutes={cell.minutes}
                    data-in-range={cell.inRange}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-medium">
        <span>Less</span>
        {INTENSITY_TIERS.map((t) => (
          <span
            key={t.min}
            className="inline-block w-3 h-3 rounded-[3px]"
            style={{ backgroundColor: 'hsl(var(--primary))', opacity: t.opacity }}
            title={t.label}
            aria-label={t.label}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
