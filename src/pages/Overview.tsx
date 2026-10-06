import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Clock3,
  MessageCircle,
  Sparkles,
  Users,
} from 'lucide-react';
import type { DashboardStats } from '../../shared/types';
import { formatDate, go, relative } from '../api';
import { Avatar, Empty, ErrorBox, Loading, PageTitle, Status, useResource } from '../components';
import { Operations } from './Operations';

export function Overview() {
  const { data, error, loading, reload } = useResource<DashboardStats>('/stats', 10000);
  if (loading) return <Loading />;
  if (error || !data) return <ErrorBox message={error} retry={reload} />;
  const cards = [
    {
      label: 'บทสนทนาทั้งหมด',
      value: data.total,
      description: 'ทุกบทสนทนาในระบบ',
      icon: MessageCircle,
      color: 'sage',
    },
    {
      label: 'รอเจ้าหน้าที่',
      value: data.waiting,
      description: 'พร้อมให้ทีมรับเรื่อง',
      icon: Clock3,
      color: 'amber',
    },
    {
      label: 'กำลังดูแล',
      value: data.active,
      description: 'มีเจ้าหน้าที่รับผิดชอบ',
      icon: Users,
      color: 'blue',
    },
    {
      label: 'ตัวอย่างพร้อมฝึก',
      value: data.approved_examples,
      description: `${data.draft_examples} ตัวอย่างรอตรวจทาน`,
      icon: Sparkles,
      color: 'purple',
    },
  ];
  const max = Math.max(4, ...data.daily.map((d) => d.count)),
    W = 650,
    H = 178,
    pad = 18;
  const points = data.daily
    .map((d, i) => `${pad + (i * (W - pad * 2)) / 6},${H - pad - (d.count / max) * (H - pad * 2)}`)
    .join(' ');
  const area = `M ${pad},${H - pad} L ${points.replaceAll(' ', ' L ')} L ${W - pad},${H - pad} Z`;
  return (
    <div className="page overview-page">
      <PageTitle
        eyebrow="YOUR WORKSPACE, AT A GLANCE"
        title="ทุกบทสนทนา เชื่อมถึงกัน"
        description="ภาพรวมการดูแลสมาชิก และองค์ความรู้ที่เติบโตไปด้วยกัน"
      >
        <span className="date-pill">
          <Clock3 size={15} />
          {formatDate(new Date(), true)}
        </span>
        <button className="button primary" onClick={() => go('/admin/inbox')}>
          เปิดกล่องข้อความ <ArrowUpRight size={17} />
        </button>
      </PageTitle>
      <div className="metrics">
        {cards.map((c) => (
          <button
            className="metric"
            key={c.label}
            onClick={() =>
              go(
                c.label === 'ตัวอย่างพร้อมฝึก'
                  ? '/admin/training'
                  : `/admin/inbox${c.label === 'รอเจ้าหน้าที่' ? '?status=WAITING_FOR_AGENT' : c.label === 'กำลังดูแล' ? '?status=AGENT_IN_CHARGE' : ''}`,
              )
            }
          >
            <div className="metric-top">
              <span>{c.label}</span>
              <div className={`metric-icon ${c.color}`}>
                <c.icon size={19} />
              </div>
            </div>
            <strong>{c.value.toLocaleString()}</strong>
            <div className="metric-bottom">
              <span>{c.description}</span>
              <ArrowUpRight size={15} />
            </div>
          </button>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <h2>ภาพรวมบทสนทนา</h2>
              <p>กิจกรรมของสมาชิกในช่วง 7 วันที่ผ่านมา</p>
            </div>
            <span className="subtle-pill">7 วันล่าสุด</span>
          </div>
          <div className="chart-legend">
            <span>
              <i className="green" />
              บทสนทนาใหม่
            </span>
            <b>
              {data.daily.reduce((n, d) => n + d.count, 0)} <small>บทสนทนา</small>
            </b>
          </div>
          <div className="chart">
            <div className="chart-axis">
              {[max, Math.round(max * 0.75), Math.round(max * 0.5), Math.round(max * 0.25), 0].map(
                (n, i) => (
                  <span key={i}>{n}</span>
                ),
              )}
            </div>
            <div className="chart-main">
              <svg
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label="กราฟจำนวนบทสนทนาใหม่ 7 วัน"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5c9b7d" stopOpacity=".25" />
                    <stop offset="100%" stopColor="#5c9b7d" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[0, 1, 2, 3, 4].map((i) => (
                  <line
                    key={i}
                    x1={pad}
                    x2={W - pad}
                    y1={pad + (i * (H - pad * 2)) / 4}
                    y2={pad + (i * (H - pad * 2)) / 4}
                    stroke="#e9ece8"
                    strokeDasharray="4 5"
                  />
                ))}
                <path d={area} fill="url(#chart-fill)" />
                <polyline
                  points={points}
                  fill="none"
                  stroke="#38745c"
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                />
                {data.daily.map((d, i) => (
                  <circle
                    key={d.day}
                    cx={pad + (i * (W - pad * 2)) / 6}
                    cy={H - pad - (d.count / max) * (H - pad * 2)}
                    r="4"
                    fill="white"
                    stroke="#38745c"
                    strokeWidth="2"
                  >
                    <title>
                      {d.day}: {d.count} บทสนทนา
                    </title>
                  </circle>
                ))}
              </svg>
              <div className="chart-days">
                {data.daily.map((d) => (
                  <span key={d.day}>
                    {new Intl.DateTimeFormat('th-TH', {
                      day: 'numeric',
                      month: 'short',
                      timeZone: 'Asia/Bangkok',
                    }).format(new Date(d.day + 'T12:00:00+07:00'))}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>
        <section className="panel topics-panel">
          <div className="panel-heading">
            <div>
              <h2>สมาชิกคุยเรื่องอะไร</h2>
              <p>หมวดหมู่จากเคสทั้งหมด</p>
            </div>
            <MessageCircle size={19} />
          </div>
          <div className="topic-bars">
            {data.categories.map((c, i) => (
              <div className="topic-row" key={c.category}>
                <div>
                  <span>
                    <i className={`topic-dot topic-${i % 5}`} />
                    {c.category}
                  </span>
                  <b>{c.count}</b>
                </div>
                <div className="bar-track">
                  <span
                    className={`topic-${i % 5}`}
                    style={{ width: `${(c.count / Math.max(1, data.total)) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="panel-footnote">จัดกลุ่มเพื่อให้ทีมดูแลได้ตรงประเด็น</div>
        </section>
      </div>
      <Operations data={data.operations} />
      <div className="overview-lower">
        <section className="panel waiting-panel">
          <div className="panel-heading">
            <div>
              <h2>
                รอการดูแล <span className="count-bubble">{data.waiting}</span>
              </h2>
              <p>บทสนทนาที่กำลังรอเจ้าหน้าที่รับเรื่อง</p>
            </div>
            <button
              className="text-button"
              onClick={() => go('/admin/inbox?status=WAITING_FOR_AGENT')}
            >
              ดูทั้งหมด <ArrowRight size={15} />
            </button>
          </div>
          {data.recent.length ? (
            <div className="waiting-table">
              {data.recent.map((c) => (
                <button
                  className="waiting-row"
                  key={c.id}
                  onClick={() => go(`/admin/inbox?case=${c.id}`)}
                >
                  <Avatar name={c.name} color={c.avatar_color} />
                  <div className="waiting-name">
                    <strong>{c.name}</strong>
                    <span>{c.subject}</span>
                  </div>
                  <span className="waiting-time">
                    <Clock3 size={13} />
                    {relative(c.handover_at ?? c.created_at)}
                    {c.supervisor_alert_status === 'ACCEPTED'
                      ? ' · แจ้ง Supervisor แล้ว'
                      : c.supervisor_alert_status === 'SIMULATED'
                        ? ' · จำลองแจ้ง Supervisor แล้ว'
                        : c.supervisor_alert_status === 'FAILED'
                          ? ' · แจ้งเตือนไม่สำเร็จ'
                          : ''}
                  </span>
                  <ArrowUpRight size={17} />
                </button>
              ))}
            </div>
          ) : (
            <Empty title="ไม่มีเคสค้างในคิว" description="ทีมดูแลสมาชิกครบแล้ว" />
          )}
        </section>
        <section className="knowledge-callout">
          <div className="callout-top">
            <span className="eyebrow">HUMAN KNOWLEDGE. BETTER AI.</span>
            <Sparkles size={24} />
          </div>
          <h2>
            คำตอบจากทีม
            <br />
            คือจุดเริ่มต้นของ AI ที่ดี
          </h2>
          <p>
            คัดเลือกบทสนทนาที่ช่วยสมาชิกได้จริง
            <br />
            ตรวจทาน แล้วส่งต่อเป็นชุดข้อมูลคุณภาพ
          </p>
          <div className="learning-progress">
            <span>
              <b>{data.approved_examples}</b> พร้อมใช้งาน
            </span>
            <span>
              <b>{data.draft_examples}</b> รอตรวจทาน
            </span>
          </div>
          <button className="button dark" onClick={() => go('/admin/training')}>
            จัดการชุดข้อมูล AI <ArrowRight size={16} />
          </button>
        </section>
      </div>
      <footer className="page-footer">
        <span>
          <ShieldIcon /> บทสนทนาถูกจัดเก็บอย่างเป็นระบบ พร้อมตรวจสอบย้อนหลัง
        </span>
        <span>
          CUSA MEMBER DESK <i /> WORKSPACE
        </span>
      </footer>
    </div>
  );
}
function ShieldIcon() {
  return <CheckCircle2 size={14} />;
}
