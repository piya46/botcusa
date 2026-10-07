import { Clock3, Timer, Users } from 'lucide-react';
import type { DashboardStats } from '../../shared/types';
import { go } from '../api';

const duration = (seconds: number | null) =>
  seconds === null ? '—' : seconds < 60 ? `${seconds} วินาที` : `${Math.round(seconds / 60)} นาที`;
export function Operations({ data }: { data: DashboardStats['operations'] }) {
  const maximum = Math.max(1, ...data.hourly.map((h) => h.count));
  return (
    <div className="operations-grid">
      <section className="panel operations-panel">
        <div className="panel-heading">
          <div>
            <h2>
              <Timer size={18} /> เวลารับเคสของทีม
            </h2>
            <p>รอบส่งต่อล่าสุด · 30 วัน</p>
          </div>
        </div>
        <div className="sla-metrics">
          <div>
            <span>รับงานเฉลี่ย</span>
            <strong>{duration(data.average_seconds)}</strong>
            <small>90% รับภายใน {duration(data.p90_seconds)}</small>
          </div>
          <div>
            <span>รับภายใน {data.target_minutes} นาที</span>
            <strong>
              {data.claimed ? `${Math.round((data.within_target / data.claimed) * 100)}%` : '—'}
            </strong>
            <small>
              {data.within_target} / {data.claimed} เคสที่รับแล้ว
            </small>
          </div>
        </div>
        <button
          className="overdue-link"
          onClick={() => go('/admin/inbox?status=WAITING_FOR_AGENT')}
        >
          <Clock3 size={17} />
          <span>
            ขณะนี้รอเกิน {data.target_minutes} นาที <b>{data.overdue} เคส</b>
          </span>
        </button>
        <p className="panel-footnote">
          {data.supervisor_configured
            ? 'แจ้ง Supervisor หนึ่งครั้งต่อรอบส่งต่อที่รอเกินกำหนด'
            : 'ยังไม่ได้ตั้งค่าผู้รับแจ้งเตือน Supervisor'}
          {data.failed_alerts > 0 && ` · แจ้งเตือนไม่สำเร็จ ${data.failed_alerts} เคส`}
        </p>
      </section>
      <section className="panel operations-panel">
        <div className="panel-heading">
          <div>
            <h2>
              <Users size={18} /> ช่วงเวลาที่สมาชิกติดต่อ
            </h2>
            <p>7 วันล่าสุด · เวลาไทย</p>
          </div>
        </div>
        <div className="hourly-chart" role="img" aria-label="จำนวนข้อความขาเข้าตามชั่วโมง เวลาไทย">
          {data.hourly.map((h) => (
            <div
              className="hourly-column"
              key={h.hour}
              title={`${String(h.hour).padStart(2, '0')}:00–${String(h.hour).padStart(2, '0')}:59 · ${h.count} ข้อความ`}
            >
              <div className="hourly-track">
                <span
                  style={{ height: h.count ? `${Math.max(3, (h.count / maximum) * 100)}%` : '2px' }}
                />
              </div>
              <small>{h.hour % 3 === 0 ? String(h.hour).padStart(2, '0') : ''}</small>
            </div>
          ))}
        </div>
        <p className="panel-footnote">
          รวม {data.hourly.reduce((n, h) => n + h.count, 0).toLocaleString()} ข้อความ ·
          ชี้เพื่อดูจำนวน
        </p>
      </section>
    </div>
  );
}
