import { useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Bell,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Ticket,
  X,
} from 'lucide-react';
import type { Agent } from '../shared/types';
import { api, go, notify, post } from './api';
import { Avatar, DemoBanner, Loading, Modal, Toasts } from './components';
import { Overview } from './pages/Overview';
import { InboxPage } from './pages/Inbox';
import { TrainingPage } from './pages/Training';
import { KnowledgePage, MembersPage, BroadcastPage, SettingsPage } from './pages/Management';
import { Connect } from './pages/Connect';
import { TicketsPage, TicketNotifications } from './pages/Tickets';

const navigation = [
  { path: 'overview', title: 'ภาพรวม', en: 'Overview', icon: LayoutDashboard },
  { path: 'inbox', title: 'กล่องข้อความ', en: 'Agent inbox', icon: MessageCircle },
  { path: 'tickets', title: 'เคสและการส่งต่อ', en: 'Tickets', icon: Ticket },
  { path: 'members', title: 'สมาชิก', en: 'Members', icon: Users },
  { path: 'knowledge', title: 'ฐานความรู้', en: 'Knowledge base', icon: BookOpen },
  { path: 'training', title: 'ชุดข้อมูล AI', en: 'Training studio', icon: Sparkles },
  { path: 'broadcasts', title: 'บรอดแคสต์', en: 'Broadcasts', icon: Send },
];
type Session = { agent: Agent; demo: boolean; agents?: Agent[] };
export default function App() {
  const [path, setPath] = useState(location.pathname),
    [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [mobile, setMobile] = useState(false),
    [help, setHelp] = useState(false),
    [search, setSearch] = useState('');
  useEffect(() => {
    const update = () => {
      setPath(location.pathname);
      setMobile(false);
    };
    addEventListener('popstate', update);
    return () => removeEventListener('popstate', update);
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const s = await api<Session>('/auth/me');
        if (active) setSession(s);
      } catch {
        try {
          const s = await post<Session>('/auth/demo');
          if (active) setSession(s);
        } catch {}
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  if (path.startsWith('/connect'))
    return (
      <>
        <Connect />
        <Toasts />
      </>
    );
  if (loading)
    return (
      <div className="boot">
        <Brand />
        <Loading />
      </div>
    );
  if (!session)
    return (
      <>
        <Login onLogin={setSession} />
        <Toasts />
      </>
    );
  const current = path.split('/')[2] || 'overview',
    item = navigation.find((n) => n.path === current);
  const logout = async () => {
    await post('/auth/logout');
    setSession(null);
  };
  const switchAgent = async (id: string) => {
    try {
      const s = await post<Session>('/auth/demo', { agentId: id });
      setSession(s);
      notify('เปลี่ยนบัญชีทดลองแล้ว');
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };
  return (
    <div className="app-shell">
      {mobile && (
        <button className="sidebar-scrim" aria-label="ปิดเมนู" onClick={() => setMobile(false)} />
      )}
      <aside className={`sidebar ${mobile ? 'open' : ''}`}>
        <div className="brand-row">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="ปิดเมนู"
            onClick={() => setMobile(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace">
          <div className="workspace-icon">C</div>
          <div>
            <strong>CUSA Alumni</strong>
            <span>ศิษย์เก่าสัมพันธ์</span>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="เมนูหลัก">
          {navigation.map((n) => (
            <a
              key={n.path}
              href={`/admin/${n.path}`}
              className={`nav-item ${current === n.path ? 'active' : ''}`}
              onClick={(e) => {
                e.preventDefault();
                go(`/admin/${n.path}`);
              }}
            >
              <n.icon size={19} />
              <span>{n.title}</span>
              {n.path === 'training' && <span className="nav-new">AI</span>}
              {current === n.path && <span className="nav-dot" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="learning-card">
            <div className="learning-visual">
              <MessageCircle size={22} />
              <span />
              <Sparkles size={19} />
            </div>
            <strong>คำตอบที่ดี มีคุณค่าต่อ</strong>
            <p>
              ส่งต่อความรู้จากทุกบทสนทนา
              <br />
              ให้ผู้ช่วย AI ดูแลสมาชิกได้ดีขึ้น
            </p>
            <button onClick={() => go('/admin/training')}>
              ไปที่ Training studio <ArrowRight size={15} />
            </button>
          </div>
          {session.agent.role === 'ADMIN' && (
            <a
              className={`nav-item ${current === 'settings' ? 'active' : ''}`}
              href="/admin/settings"
              onClick={(e) => {
                e.preventDefault();
                go('/admin/settings');
              }}
            >
              <Settings size={19} />
              <span>ตั้งค่าระบบ</span>
            </a>
          )}
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={19} />
            <span>คู่มือการใช้งาน</span>
          </button>
          <div className="profile">
            <Avatar name={session.agent.name} color="sage" />
            <div>
              <strong>{session.agent.name.split(' · ')[0]}</strong>
              {session.demo ? (
                <select
                  aria-label="สลับบัญชีทดลอง"
                  value={session.agent.id}
                  onChange={(e) => switchAgent(e.target.value)}
                >
                  <option value="11111111-1111-4111-8111-111111111111">พิมพ์ชนก · Admin</option>
                  <option value="22222222-2222-4222-8222-222222222222">ธนกฤต · Reviewer</option>
                  <option value="33333333-3333-4333-8333-333333333333">นลิน · Agent</option>
                </select>
              ) : (
                <span>{session.agent.role}</span>
              )}
            </div>
            <button className="icon-button" aria-label="ออกจากระบบ" onClick={logout}>
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-only"
              aria-label="เปิดเมนู"
              onClick={() => setMobile(true)}
            >
              <Menu size={22} />
            </button>
            <span>CUSA Workspace</span>
            <ChevronRight size={14} />
            <strong>{item?.en ?? 'Settings'}</strong>
          </div>
          <div className="topbar-right">
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                go(`/admin/inbox?q=${encodeURIComponent(search)}`);
                setSearch('');
              }}
            >
              <Search size={16} />
              <input
                aria-label="ค้นหาทั้งระบบ"
                placeholder="ค้นหาบทสนทนา…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <div className="connection">
              <i />
              {session.demo ? 'Demo workspace' : 'Workspace online'}
            </div>
            <TicketNotifications key={session.agent.id} />
          </div>
        </header>
        {session.demo && <DemoBanner />}
        <main
          className={current === 'inbox' ? 'main-content inbox-main' : 'main-content'}
          key={`${current}:${session.agent.id}`}
        >
          {current === 'overview' ? (
            <Overview />
          ) : current === 'inbox' ? (
            <InboxPage agent={session.agent} demo={session.demo} />
          ) : current === 'training' ? (
            <TrainingPage agent={session.agent} />
          ) : current === 'tickets' ? (
            <TicketsPage agent={session.agent} />
          ) : current === 'knowledge' ? (
            <KnowledgePage agent={session.agent} />
          ) : current === 'members' ? (
            <MembersPage agent={session.agent} />
          ) : current === 'broadcasts' ? (
            <BroadcastPage agent={session.agent} demo={session.demo} />
          ) : current === 'settings' ? (
            <SettingsPage />
          ) : (
            <Overview />
          )}
        </main>
      </div>
      {help && (
        <Modal
          title="ดูแลสมาชิก ตั้งแต่ต้นจนจบ"
          subtitle="แนวทางใช้งาน CUSA Member Desk"
          onClose={() => setHelp(false)}
        >
          <div className="help-steps">
            <p>
              <b>01 · รับเรื่อง</b> เปิดกล่องข้อความ เลือกเคสที่รอ แล้วกด “รับเคสนี้”
            </p>
            <p>
              <b>02 · สนทนา</b> ตอบสมาชิกผ่านช่องข้อความ ระบบบันทึกคำตอบและสถานะการส่ง
              บันทึกภายในจะเห็นเฉพาะทีมงาน
            </p>
            <p>
              <b>03 · ปิดเคส</b> ระบุผลการช่วยเหลือและสรุปเคส เมื่อสมาชิกทักมาใหม่
              ระบบจะเริ่มบทสนทนาใหม่
            </p>
            <p>
              <b>04 · ส่งต่อความรู้</b> สร้างตัวอย่างฝึกจากเคสที่แก้สำเร็จ ตรวจข้อมูลส่วนบุคคล
              แล้วให้ผู้ตรวจทานอีกคนอนุมัติ
            </p>
            <p>
              <b>05 · ส่งออก</b> สร้างเวอร์ชันชุดข้อมูลและดาวน์โหลด JSONL แยกชุดฝึก ตรวจสอบ
              และทดสอบได้
            </p>
          </div>
          <div className="modal-footer">
            <button className="button primary" onClick={() => setHelp(false)}>
              เริ่มใช้งาน <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
      <Toasts />
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Activity size={23} />
      </span>
      <div>
        <strong>
          CUSA<span>®</span>
        </strong>
        <small>MEMBER DESK</small>
      </div>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">CONNECTED BY CONVERSATION</span>
          <h1>
            ทุกบทสนทนา
            <br />
            เชื่อมถึงกัน<span>.</span>
          </h1>
          <p>
            พื้นที่ของทีมดูแลสมาชิก
            <br />
            และความรู้ที่เติบโตไปด้วยกัน
          </p>
        </div>
        <small>CUSA · Faculty of Science Alumni</small>
      </div>
      <div className="login-form">
        <div className="login-icon">
          <ShieldCheck size={28} />
        </div>
        <h2>ยินดีต้อนรับกลับ</h2>
        <p>เข้าสู่ระบบสำหรับเจ้าหน้าที่ Member Desk</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              onLogin(await post('/auth/login', { email, password }));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            อีเมล
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@organization.org"
            />
          </label>
          <label>
            รหัสผ่าน
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="button primary" disabled={busy}>
            {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            <ArrowRight size={18} />
          </button>
        </form>
        <p className="login-note">
          บัญชีเจ้าหน้าที่ออกโดยผู้ดูแลระบบ
          <br />
          สมาชิกยืนยันตัวตนผ่านเมนู LINE ของสมาคม
        </p>
      </div>
    </div>
  );
}
