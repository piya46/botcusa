import type { Config } from './config.js';
import type { Queryable } from './db.js';
import type { DashboardStats } from '../shared/types.js';

export async function operationalStats(db: Queryable, config: Config) {
  if (db.dialect === 'mysql') return mysqlOperationalStats(db, config);
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

async function mysqlOperationalStats(db: Queryable, config: Config) {
  const times = await db.query<{ seconds: number; within_target: number }>(
    `SELECT GREATEST(0,TIMESTAMPDIFF(MICROSECOND,handover_at,claimed_at)/1000000) AS seconds,claimed_at<=handover_at+INTERVAL 5 MINUTE AS within_target FROM conversations WHERE handover_at>=now()-INTERVAL 30 DAY AND claimed_at IS NOT NULL ORDER BY seconds`,
  );
  const [waiting] = await db.query(
    `SELECT count(*) FILTER(WHERE handover_at<=now()-interval '5 minutes')::int AS overdue,count(*) FILTER(WHERE supervisor_alert_status='FAILED')::int AS failed_alerts FROM conversations WHERE status='WAITING_FOR_AGENT'`,
  );
  const hours = await db.query<{ hour: number; count: number }>(
    `SELECT HOUR(DATE_ADD(created_at,INTERVAL 7 HOUR)) AS hour,COUNT(*) AS count FROM messages WHERE created_at>=now()-INTERVAL 7 DAY AND sender_type='USER' AND withdrawn_at IS NULL GROUP BY hour ORDER BY hour`,
  );
  const position = (times.length - 1) * 0.9;
  const lower = Math.floor(position),
    upper = Math.ceil(position);
  return {
    claimed: times.length,
    within_target: times.filter((row) => row.within_target).length,
    average_seconds: times.length
      ? Math.round(times.reduce((sum, row) => sum + row.seconds, 0) / times.length)
      : null,
    p90_seconds: times.length
      ? Math.round(
          times[lower].seconds + (times[upper].seconds - times[lower].seconds) * (position - lower),
        )
      : null,
    ...waiting,
    target_minutes: 5,
    supervisor_configured: config.demo || Boolean(config.supervisorAlertId),
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: hours.find((row) => row.hour === hour)?.count ?? 0,
    })),
  };
}
