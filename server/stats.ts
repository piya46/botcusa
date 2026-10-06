import type { Config } from './config.js';
import type { Queryable } from './db.js';
import type { DashboardStats } from '../shared/types.js';

export async function operationalStats(db: Queryable, config: Config) {
  const [sla] = await db.query<
    Pick<
      DashboardStats['operations'],
      'claimed' | 'within_target' | 'average_seconds' | 'p90_seconds'
    >
  >(`SELECT
    count(*) FILTER(WHERE claimed_at IS NOT NULL)::int AS claimed,
    count(*) FILTER(WHERE claimed_at IS NOT NULL AND claimed_at<=handover_at+interval '5 minutes')::int AS within_target,
    round(avg(GREATEST(0,extract(epoch FROM claimed_at-handover_at))) FILTER(WHERE claimed_at IS NOT NULL))::int AS average_seconds,
    round((percentile_cont(0.9) WITHIN GROUP(ORDER BY GREATEST(0,extract(epoch FROM claimed_at-handover_at))) FILTER(WHERE claimed_at IS NOT NULL))::numeric)::int AS p90_seconds
    FROM conversations WHERE handover_at>=now()-interval '30 days'`);
  const [waiting] = await db.query<
    Pick<DashboardStats['operations'], 'overdue' | 'failed_alerts'>
  >(`SELECT
    count(*) FILTER(WHERE handover_at<=now()-interval '5 minutes')::int AS overdue,
    count(*) FILTER(WHERE supervisor_alert_status='FAILED')::int AS failed_alerts
    FROM conversations WHERE status='WAITING_FOR_AGENT'`);
  const hourly = await db.query<{
    hour: number;
    count: number;
  }>(`SELECT h.hour,count(m.id)::int AS count
    FROM generate_series(0,23) AS h(hour) LEFT JOIN messages m
    ON extract(hour FROM m.created_at AT TIME ZONE 'Asia/Bangkok')=h.hour
    AND m.created_at>=now()-interval '7 days' AND m.sender_type='USER' AND m.withdrawn_at IS NULL
    GROUP BY h.hour ORDER BY h.hour`);
  return {
    ...sla,
    ...waiting,
    target_minutes: 5,
    supervisor_configured: config.demo || Boolean(config.supervisorAlertId),
    hourly,
  };
}
