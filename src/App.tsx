import { useEffect, useRef, useState } from 'react';
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
import { InsightsPage } from './pages/Insights';
import { Install } from './pages/Install';

const navigation = [
  { path: 'overview', title: 'ภาพรวม', en: 'Overview', icon: LayoutDashboard },
  { path: 'inbox', title: 'กล่องข้อความ', en: 'Agent inbox', icon: MessageCircle },
  { path: 'tickets', title: 'เคสและการส่งต่อ', en: 'Tickets', icon: Ticket },
  { path: 'members', title: 'สมาชิก', en: 'Members', icon: Users },
  { path: 'knowledge', title: 'ฐานความรู้', en: 'Knowledge base', icon: BookOpen },
  { path: 'insights', title: 'คำถามค้าง / วิเคราะห์', en: 'Insights', icon: Activity },
  { path: 'training', title: 'ชุดข้อมูล AI', en: 'Training studio', icon: Sparkles },
  { path: 'broadcasts', title: 'บรอดแคสต์', en: 'Broadcasts', icon: Send },
];
const navigationGroups = [
  { title: 'งานบริการ', paths: ['overview', 'inbox', 'tickets', 'members'] },
  { title: 'ความรู้และ AI', paths: ['knowledge', 'insights', 'training'] },
  { title: 'สื่อสาร', paths: ['broadcasts'] },
];
type Session = { agent: Agent; demo: boolean; agents?: Agent[] };
export default function App() {
  const [path, setPath] = useState(location.pathname),
    [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [mobile, setMobile] = useState(false),
    [help, setHelp] = useState(false),
    [expired, setExpired] = useState(false),
    [logoutWarning, setLogoutWarning] = useState(''),
    [search, setSearch] = useState('');
  useEffect(() => {
    const expire = () => setExpired(true);
    addEventListener('session-expired', expire);
    return () => removeEventListener('session-expired', expire);
  }, []);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInput.current?.focus();
      }
      if (e.key === 'Escape') setMobile(false);
    };
    addEventListener('keydown', shortcut);
    return () => removeEventListener('keydown', shortcut);
  }, []);
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
    if (location.pathname === '/install' || new URLSearchParams(location.search).has('reauth')) {
      setLoading(false);
      return;
    }
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
  if (path === '/install') return <Install />;
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
        <Login warning={logoutWarning} />
        <Toasts />
      </>
    );
  const current = path.split('/')[2] || 'overview',
    item = navigation.find((n) => n.path === current);
  const logout = async () => {
    try {
      const result = await post<{ ssoRevoked?: boolean }>('/auth/logout');
      setLogoutWarning(
        result.ssoRevoked === false
          ? 'ออกจาก Member Desk แล้ว แต่ CUSA ยังยืนยันการถอนเซสชันไม่ได้'
          : '',
      );
      setExpired(false);
      setSession(null);
    } catch (error) {
      notify((error as Error).message, 'error');
    }
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
        <nav aria-label="เมนูหลัก" className="grouped-navigation">
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-caption">{group.title}</div>
              {navigation
                .filter((n) => group.paths.includes(n.path))
                .map((n) => (
                  <a
                    key={n.path}
                    href={`/admin/${n.path}`}
                    className={`nav-item ${current === n.path ? 'active' : ''}`}
                    aria-current={current === n.path ? 'page' : undefined}
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
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
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
            <strong>{item?.title ?? 'ตั้งค่าระบบ'}</strong>
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
                ref={searchInput}
                aria-label="ค้นหาทั้งระบบ"
                placeholder="ค้นหาเคส…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>⌘ K</kbd>
            </form>
            <div className="connection">
              <i />
              {session.demo ? 'Demo' : 'ออนไลน์'}
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
          ) : current === 'insights' ? (
            <InsightsPage agent={session.agent} />
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
      {expired && (
        <Modal
          title="ยืนยันตัวตนเพื่อทำงานต่อ"
          subtitle="งานที่กำลังพิมพ์ยังอยู่ในหน้านี้"
          onClose={() => {}}
        >
          <p>
            CUSA SSO หมดอายุหรือสิทธิ์เปลี่ยน เปิดแท็บใหม่เพื่อเข้าสู่ระบบ แล้วกลับมาตรวจสอบที่นี่
          </p>
          <div className="modal-footer">
            <a className="button secondary" href="/admin?reauth=1" target="_blank" rel="noopener">
              เปิด CUSA SSO
            </a>
            <button
              className="button primary"
              onClick={async () => {
                try {
                  const next = await api<Session>('/auth/me');
                  if (next.agent.id !== session.agent.id) {
                    location.reload();
                    return;
                  }
                  setSession(next);
                  setExpired(false);
                  notify('ยืนยันตัวตนแล้ว ทำงานต่อได้');
                } catch {
                  notify('ยังยืนยันตัวตนไม่สำเร็จ กรุณาเข้าสู่ระบบในแท็บใหม่', 'error');
                }
              }}
            >
              ยืนยันตัวตนแล้ว
            </button>
          </div>
        </Modal>
      )}
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
function Login({ warning }: { warning?: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(() => {
      const reason = new URLSearchParams(location.search).get('auth');
      return reason === 'conflict'
        ? 'บัญชีอีเมลนี้มีอยู่แล้ว ติดต่อผู้ดูแลเพื่อย้ายบัญชีเดิม'
        : reason
          ? 'เข้าสู่ระบบไม่สำเร็จ ตรวจบทบาทของแอปกับผู้ดูแล CUSA แล้วลองใหม่'
          : '';
    });
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
        {warning && (
          <p role="status" className="form-error">
            {warning}
          </p>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const result = await post<{ url: string }>('/auth/sso/start');
              location.assign(result.url);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && <p className="form-error">{error}</p>}
          <button className="button primary" disabled={busy}>
            {busy ? 'กำลังไป CUSA SSO…' : 'เข้าสู่ระบบด้วย CUSA SSO'}
            <ArrowRight size={18} />
          </button>
        </form>
        <p className="login-note">
          ใช้บัญชี CUSA ที่มีบทบาทของ Member Desk
          <br />
          สมาชิกยืนยันตัวตนผ่านเมนู LINE ของสมาคม
        </p>
      </div>
    </div>
  );
}
