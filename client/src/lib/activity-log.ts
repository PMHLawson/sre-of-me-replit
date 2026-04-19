import {
  findActiveDeviationAt,
  type Deviation,
  type Domain,
  type Session,
} from '@/store';

export type ActivityLogEntry =
  | {
      kind: 'session';
      timestamp: string;
      domain: Domain;
      session: Session;
      deviationContext: Deviation | undefined;
    }
  | {
      kind: 'deviation-start';
      timestamp: string;
      domain: Domain;
      deviation: Deviation;
    }
  | {
      kind: 'deviation-end';
      timestamp: string;
      domain: Domain;
      deviation: Deviation;
      endedEarly: boolean;
    };

/**
 * Merge sessions and deviation lifecycle events into one chronological stream
 * (newest first). Deleted sessions and deleted deviations are excluded so the
 * log mirrors what users see on the dashboard. Each session entry carries the
 * deviation that covers its timestamp (if any) so consumers don't need to
 * re-query the store while rendering.
 *
 * Pure: same inputs always produce the same output. No side effects, no I/O.
 */
export function buildActivityLog(
  sessions: Session[],
  deviations: Deviation[],
): ActivityLogEntry[] {
  const entries: ActivityLogEntry[] = [];
  const now = new Date();

  for (const session of sessions) {
    if (session.deletedAt) continue;
    const domain = session.domain;
    entries.push({
      kind: 'session',
      timestamp: session.timestamp,
      domain,
      session,
      deviationContext: findActiveDeviationAt(
        deviations,
        domain,
        new Date(session.timestamp),
      ),
    });
  }

  for (const deviation of deviations) {
    if (deviation.deletedAt) continue;
    const devDomain = deviation.domain as Domain;

    entries.push({
      kind: 'deviation-start',
      timestamp: deviation.startAt,
      domain: devDomain,
      deviation,
    });

    // End event: prefer manual endedAt; otherwise use the planned endAt once
    // it has actually elapsed. Open-ended deviations (no endedAt and either
    // no endAt or a future endAt) get no end entry until they truly close.
    let endTimestamp: string | null = null;
    let endedEarly = false;
    if (deviation.endedAt) {
      endTimestamp = deviation.endedAt;
      endedEarly = !!(
        deviation.endAt && new Date(deviation.endedAt) < new Date(deviation.endAt)
      );
    } else if (deviation.endAt && new Date(deviation.endAt) <= now) {
      endTimestamp = deviation.endAt;
    }

    if (endTimestamp) {
      entries.push({
        kind: 'deviation-end',
        timestamp: endTimestamp,
        domain: devDomain,
        deviation,
        endedEarly,
      });
    }
  }

  entries.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return entries;
}
