import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  FileText,
  ImagePlus,
  Info,
  LockKeyhole,
  MessageCircle,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  Forward,
  History,
} from 'lucide-react';
import type {
  Agent,
  CaseState,
  Conversation,
  Message,
  Team,
  CaseTransfer,
} from '../../shared/types';
import { TransferDialog } from './Tickets';
import { AiReplyDetails } from './AiReplyDetails';
import { api, clockTime, formatDate, notify, post, relative } from '../api';
import {
  Avatar,
  Delivery,
  Empty,
  ErrorBox,
  Loading,
  Modal,
  Status,
  useResource,
} from '../components';

export function InboxPage({ agent, demo }: { agent: Agent; demo: boolean }) {
  const params = new URLSearchParams(location.search);
  const [status, setStatus] = useState(params.get('status') ?? 'ALL'),
    [search, setSearch] = useState(params.get('q') ?? ''),
    [selected, setSelected] = useState<string | null>(params.get('case')),
    [mine, setMine] = useState(false),
    [simulate, setSimulate] = useState(false),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useResource<Conversation[]>(
    `/conversations?status=${status}&search=${encodeURIComponent(search)}&mine=${mine}`,
    4000,
  );
  useEffect(() => {
    const handler = () => {
      const q = new URLSearchParams(location.search);
      setSearch(q.get('q') ?? '');
      setStatus(q.get('status') ?? 'ALL');
      if (q.get('case')) setSelected(q.get('case'));
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  useEffect(() => {
    if (!selected && data?.length && window.innerWidth > 760) setSelected(data[0].id);
  }, [data]);
  return (
    <div className={`inbox-layout ${selected ? 'has-selection' : ''}`}>
      <section className="conversation-list">
        <div className="list-heading">
          <div>
            <h1>
              กล่องข้อความ <span className="count-bubble">{data?.length ?? 0}</span>
            </h1>
            <p>ดูแลทุกบทสนทนาในที่เดียว</p>
          </div>
          {demo && (
            <button
              className="icon-button"
              title="จำลองข้อความจากสมาชิก"
              aria-label="จำลองข้อความจากสมาชิก"
              onClick={() => setSimulate(true)}
            >
              <Plus size={20} />
            </button>
          )}
        </div>
        <div className="list-search">
          <Search size={17} />
          <input
            placeholder="ค้นหาชื่อ หรือหัวข้อ…"
            aria-label="ค้นหาบทสนทนา"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="inbox-tabs">
          <button className={!mine ? 'active' : ''} onClick={() => setMine(false)}>
            ทั้งหมด
          </button>
          <button className={mine ? 'active' : ''} onClick={() => setMine(true)}>
            ที่ฉันดูแล
          </button>
        </div>
        <div className="list-filter">
          <label>
            <span>สถานะ</span>
            <select
              aria-label="กรองสถานะ"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="ALL">ทุกสถานะ</option>
              <option value="WAITING_FOR_AGENT">รอเจ้าหน้าที่</option>
              <option value="AGENT_IN_CHARGE">กำลังดูแล</option>
              <option value="BOT">ผู้ช่วย AI ดูแล</option>
              <option value="CLOSED">ปิดเคสแล้ว</option>
            </select>
          </label>
          <span>ล่าสุดก่อน</span>
        </div>
        <div className="list-scroll">
          {loading ? (
            <Loading />
          ) : error ? (
            <ErrorBox message={error} retry={reload} />
          ) : !data?.length ? (
            <Empty title="ไม่พบบทสนทนา" description="ลองเปลี่ยนคำค้นหาหรือตัวกรอง" />
          ) : (
            data.map((c) => (
              <button
                className={`conversation-item ${selected === c.id ? 'selected' : ''}`}
                key={c.id}
                onClick={() => setSelected(c.id)}
              >
                <Avatar name={c.name} color={c.avatar_color} />
                <div className="conversation-snippet">
                  <div className="snippet-top">
                    <strong>{c.name}</strong>
                    <time>{relative(c.updated_at)}</time>
                  </div>
                  <span className="snippet-subject">
                    {c.cusa_sub ? 'เชื่อมบัญชี CUSA แล้ว' : 'ผู้ติดต่อ LINE'} · {c.subject}
                  </span>
                  <p>{c.last_message ?? 'ยังไม่มีข้อความ'}</p>
                  <div className="snippet-bottom">
                    <Status state={c.status} />
                    {c.priority === 'HIGH' && <span className="priority-mark">เร่งด่วน</span>}
                    <small>#{String(c.number).padStart(4, '0')}</small>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
        <div className="list-footer">
          <ShieldCheck size={13} /> บันทึกทุกข้อความที่ผ่าน Member Desk
        </div>
      </section>
      {selected ? (
        <SelectedCase
          key={selected}
          id={selected}
          agent={agent}
          demo={demo}
          onUpdate={reload}
          onBack={() => setSelected(null)}
        />
      ) : (
        <div className="chat-no-selection">
          <Empty title="เลือกบทสนทนา" description="เปิดเคสเพื่ออ่านหรือตอบข้อความ" />
        </div>
      )}
      {simulate && (
        <Modal
          title="จำลองข้อความจากสมาชิก"
          subtitle="ทดสอบการรับข้อความและการส่งต่อ โดยไม่ส่งไป LINE จริง"
          onClose={() => setSimulate(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post('/demo/message', { text });
                notify('รับข้อความจำลองแล้ว กำลังประมวลผล');
                setSimulate(false);
                setText('');
                setTimeout(reload, 1000);
              } catch (e) {
                notify((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              ข้อความ
              <textarea
                rows={4}
                required
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="สวัสดีค่ะ ขอติดต่อเจ้าหน้าที่ค่ะ"
              />
            </label>
            <div className="modal-footer">
              <button type="button" className="button" onClick={() => setSimulate(false)}>
                ยกเลิก
              </button>
              <button className="button primary" disabled={busy || !text.trim()}>
                ส่งข้อความจำลอง <Send size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function SelectedCase({
  id,
  agent,
  demo,
  onUpdate,
  onBack,
}: {
  id: string;
  agent: Agent;
  demo: boolean;
  onUpdate: () => void;
  onBack: () => void;
}) {
  const { data, error, loading, reload } = useResource<{
    conversation: Conversation;
    messages: Message[];
    transfers: CaseTransfer[];
  }>(`/conversations/${id}`, 2500);
  const teams = useResource<Team[]>('/teams');
  const [text, setText] = useState(''),
    [internal, setInternal] = useState(false),
    [busy, setBusy] = useState(false),
    [close, setClose] = useState(false),
    [transfer, setTransfer] = useState(false),
    [history, setHistory] = useState(false),
    [note, setNote] = useState(''),
    [resolution, setResolution] = useState('RESOLVED_HUMAN'),
    [details, setDetails] = useState(window.innerWidth > 1280),
    [simulator, setSimulator] = useState(false),
    [incoming, setIncoming] = useState('');
  const end = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    requestId = useRef(crypto.randomUUID());
  const messageCount = data?.messages.length;
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messageCount]);
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) notify(success);
      await reload();
      onUpdate();
      return true;
    } catch (e) {
      notify((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    const sent = await run(() =>
      post(`/conversations/${id}/messages`, { text, internal, clientRequestId: requestId.current }),
    );
    if (sent) {
      setText('');
      requestId.current = crypto.randomUUID();
    }
  };
  if (loading)
    return (
      <div className="chat-no-selection">
        <Loading />
      </div>
    );
  if (error || !data)
    return (
      <div className="chat-no-selection">
        <ErrorBox message={error} retry={reload} />
      </div>
    );
  const c = data.conversation,
    canAnswer =
      c.status === 'AGENT_IN_CHARGE' &&
      (c.assigned_agent_id === agent.id || agent.role === 'ADMIN') &&
      agent.role !== 'REVIEWER';
  const canClaim =
    agent.role !== 'REVIEWER' &&
    (agent.role === 'ADMIN' ||
      ((!c.assigned_agent_id || c.assigned_agent_id === agent.id) &&
        (!c.team_id ||
          teams.data?.some(
            (t) => t.id === c.team_id && t.members.some((a) => a.id === agent.id),
          ))));
  const canTransfer = c.status !== 'CLOSED' && (canAnswer || agent.role === 'ADMIN');
  return (
    <>
      <section className="chat-panel">
        <header className="chat-header">
          <button className="icon-button mobile-only" aria-label="กลับไปรายการ" onClick={onBack}>
            <ArrowLeft size={20} />
          </button>
          <Avatar name={c.name} color={c.avatar_color} />
          <div className="chat-identity">
            <strong>{c.name}</strong>
            <span>
              <i className="line-dot" />
              {c.cusa_sub ? 'เชื่อมบัญชี CUSA แล้ว' : 'ผู้ติดต่อ LINE'} <span>·</span> เคส #
              {String(c.number).padStart(4, '0')}
            </span>
          </div>
          <div className="chat-header-actions">
            {canTransfer && (
              <button
                className="button small"
                aria-label="โอนเคส"
                title="โอนเคส"
                onClick={() => setTransfer(true)}
              >
                <Forward size={16} />
                <span className="transfer-button-label">โอนเคส</span>
              </button>
            )}
            {Boolean(data.transfers.length) && (
              <button
                className="icon-button"
                aria-label="ประวัติการโอนเคส"
                title="ประวัติการโอนเคส"
                onClick={() => setHistory(true)}
              >
                <History size={18} />
              </button>
            )}
            <a
              className="icon-button"
              href={`/api/conversations/${id}/transcript`}
              title="ดาวน์โหลดประวัติ"
              aria-label="ดาวน์โหลดประวัติ"
            >
              <Download size={18} />
            </a>
            <button
              className="icon-button details-toggle"
              aria-label="แสดงหรือซ่อนรายละเอียด"
              onClick={() => setDetails(!details)}
            >
              {details ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
            </button>
            {canAnswer && (
              <button className="button small" onClick={() => setClose(true)}>
                <CheckCircle2 size={16} />
                ปิดเคส
              </button>
            )}
          </div>
        </header>
        {c.status === 'WAITING_FOR_AGENT' || c.status === 'BOT' ? (
          <div className="handover-banner">
            <div>
              <span className="handover-icon">
                {c.status === 'BOT' ? <Bot size={19} /> : <Clock3 size={19} />}
              </span>
              <div>
                <strong>
                  {c.status === 'BOT'
                    ? 'ผู้ช่วย AI กำลังดูแลบทสนทนานี้'
                    : 'สมาชิกกำลังรอความช่วยเหลือ'}
                </strong>
                <span>
                  {c.status === 'BOT'
                    ? 'รับงานเพื่อเริ่มสนทนากับสมาชิกด้วยตัวเอง'
                    : `ส่งต่อเมื่อ ${clockTime(c.handover_at ?? c.created_at)} · บอทหยุดตอบแล้ว`}
                </span>
              </div>
            </div>
            {canClaim && (
              <button
                className="button primary small"
                disabled={busy}
                onClick={() =>
                  run(() => post(`/conversations/${id}/claim`), 'รับเคสแล้ว พร้อมตอบสมาชิก')
                }
              >
                รับเคสนี้ <ArrowRight size={15} />
              </button>
            )}
          </div>
        ) : (
          <div className={`case-status-strip ${c.status === 'CLOSED' ? 'closed' : ''}`}>
            <Status state={c.status} />
            <span>
              {c.status === 'CLOSED'
                ? `ปิดเมื่อ ${formatDate(c.closed_at!)}`
                : `ผู้ดูแล: ${c.assigned_agent_name}`}
            </span>
          </div>
        )}
        {c.team_id && (
          <div className="ticket-context">
            <strong>
              {c.team_name} · {c.assigned_agent_name ?? 'รอทีมรับงาน'}
            </strong>
            {data.transfers[0] && (
              <button onClick={() => setHistory(true)}>
                <span>เหตุผล: {data.transfers[0].reason}</span>
                <History size={14} />
              </button>
            )}
          </div>
        )}
        <div className="message-timeline">
          <div className="timeline-date">{formatDate(c.created_at, true)}</div>
          {data.messages.map((m) =>
            m.sender_type === 'SYSTEM' && m.internal && m.metadata.system_event !== 'AI_INTAKE' ? (
              <div className="system-message" key={m.id}>
                <CheckCircle2 size={12} />
                {m.text}
              </div>
            ) : (
              <div
                key={m.id}
                className={`message-row ${m.sender_type === 'USER' ? 'incoming' : 'outgoing'} ${m.internal ? 'internal-note' : ''}`}
              >
                {m.sender_type === 'USER' && (
                  <Avatar name={c.name} color={c.avatar_color} size="small" />
                )}
                <div className="message-container">
                  <div className="message-author">
                    {m.internal ? (
                      <>
                        <LockKeyhole size={12} /> บันทึกภายใน ·{' '}
                        {m.metadata.system_event === 'AI_INTAKE'
                          ? 'สรุปก่อนส่งต่อ'
                          : m.agent_name?.split(' · ')[0]}
                      </>
                    ) : m.sender_type === 'BOT' ? (
                      <>
                        <Sparkles size={12} /> CUSA Assistant
                      </>
                    ) : m.sender_type === 'SYSTEM' ? (
                      'CUSA Member Desk'
                    ) : m.sender_type === 'AGENT' ? (
                      m.agent_name?.split(' · ')[0]
                    ) : (
                      c.name
                    )}
                  </div>
                  <div className={`message-bubble ${m.withdrawn_at ? 'withdrawn' : ''}`}>
                    {m.attachment_id && m.kind === 'image' ? (
                      <a
                        href={`/api/attachments/${m.attachment_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img
                          className="chat-image"
                          src={`/api/attachments/${m.attachment_id}`}
                          alt="ภาพแนบในบทสนทนา"
                        />
                      </a>
                    ) : m.attachment_id ? (
                      <a className="attachment-link" href={`/api/attachments/${m.attachment_id}`}>
                        <FileText size={20} />
                        ดาวน์โหลดไฟล์แนบ <Download size={14} />
                      </a>
                    ) : null}
                    {!m.attachment_id || m.kind !== 'image' ? <p>{m.text}</p> : null}
                  </div>
                  <div className="message-meta">
                    <time>{clockTime(m.created_at)}</time>
                    {m.sender_type !== 'USER' && !m.internal && (
                      <Delivery state={m.delivery_status} />
                    )}
                  </div>
                  {m.sender_type === 'BOT' && <AiReplyDetails message={m} />}
                </div>
              </div>
            ),
          )}
          <div ref={end} />
        </div>
        {canAnswer ? (
          <div className={`composer ${internal ? 'note-mode' : ''}`}>
            <div className="composer-tabs">
              <button className={!internal ? 'active' : ''} onClick={() => setInternal(false)}>
                <MessageCircle size={14} />
                ตอบสมาชิก
              </button>
              <button className={internal ? 'active' : ''} onClick={() => setInternal(true)}>
                <LockKeyhole size={13} />
                บันทึกภายใน
              </button>
              <span>{internal ? 'เห็นเฉพาะทีมงาน' : 'ส่งผ่าน LINE Official Account'}</span>
            </div>
            <textarea
              aria-label={internal ? 'บันทึกภายใน' : 'ข้อความตอบสมาชิก'}
              placeholder={internal ? 'เพิ่มบริบทให้ทีมงาน…' : 'พิมพ์ข้อความเพื่อดูแลสมาชิก…'}
              value={text}
              maxLength={4500}
              onChange={(e) => {
                setText(e.target.value);
                requestId.current = crypto.randomUUID();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-toolbar">
              <div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const form = new FormData();
                    form.append('file', f);
                    await run(
                      () => api(`/conversations/${id}/image`, { method: 'POST', body: form }),
                      'บันทึกภาพและเข้าคิวส่งแล้ว',
                    );
                    e.target.value = '';
                  }}
                />
                {!internal && (
                  <button
                    className="icon-button"
                    disabled={busy}
                    title="ส่งภาพ PNG/JPEG ไม่เกิน 1 MB"
                    aria-label="ส่งรูปภาพ"
                    onClick={() => fileInput.current?.click()}
                  >
                    <ImagePlus size={19} />
                  </button>
                )}
                <span className="keyboard-hint">Ctrl / ⌘ + Enter เพื่อส่ง</span>
              </div>
              <button className="button primary" disabled={busy || !text.trim()} onClick={send}>
                {internal ? 'บันทึกโน้ต' : 'ส่งข้อความ'}
                <Send size={16} />
              </button>
            </div>
          </div>
        ) : (
          <div className="composer-disabled">
            {c.status === 'CLOSED' ? (
              <>
                <CheckCircle2 size={18} />
                <div>
                  <strong>บทสนทนานี้ปิดแล้ว</strong>
                  <span>ข้อความใหม่จากสมาชิกจะเริ่มเคสใหม่กับผู้ช่วย AI</span>
                </div>
              </>
            ) : (
              <>
                <LockKeyhole size={17} />
                <span>
                  {agent.role === 'REVIEWER'
                    ? 'โหมดตรวจทาน · อ่านบทสนทนาได้'
                    : 'รับเคสก่อนเริ่มตอบข้อความ'}
                </span>
              </>
            )}
          </div>
        )}
        {demo && (
          <button className="simulate-inline" onClick={() => setSimulator(true)}>
            <Plus size={12} /> จำลองข้อความจากสมาชิกคนนี้
          </button>
        )}
      </section>
      {details && (
        <aside className="case-details">
          <div className="detail-section member-profile">
            <Avatar name={c.name} color={c.avatar_color} size="large" />
            <h3>{c.name}</h3>
            {c.line_display_name && c.line_display_name !== c.name && (
              <span>LINE: {c.line_display_name}</span>
            )}
            <span>{c.department ?? 'ยังไม่ระบุข้อมูลสังกัด'}</span>
            <span className={`badge ${c.cusa_sub ? 'approved' : 'neutral'}`}>
              <ShieldCheck size={12} />
              {c.cusa_sub ? 'เชื่อมบัญชี CUSA แล้ว' : 'ยังไม่เชื่อม CUSA'}
            </span>
            <small className="muted">สถานะสมาชิกสมาคมต้องตรวจจากทะเบียนสมาชิก</small>
          </div>
          <div className="detail-section">
            <h4>
              รายละเอียดเคส <Info size={14} />
            </h4>
            <dl>
              <dt>หมายเลข</dt>
              <dd>#{String(c.number).padStart(4, '0')}</dd>
              <dt>สถานะ</dt>
              <dd>
                <Status state={c.status} />
              </dd>
              <dt>ผู้รับผิดชอบ</dt>
              <dd>{c.assigned_agent_name?.split(' · ')[0] ?? 'ยังไม่มีผู้รับงาน'}</dd>
              <dt>หน่วยงาน</dt>
              <dd>{c.team_name ?? 'คิวบริการส่วนกลาง'}</dd>
              <dt>เปิดเมื่อ</dt>
              <dd>{formatDate(c.created_at)}</dd>
              <dt>ความสำคัญ</dt>
              <dd className={c.priority === 'HIGH' ? 'urgent' : ''}>
                {c.priority === 'HIGH' ? 'เร่งด่วน' : 'ปกติ'}
              </dd>
            </dl>
          </div>
          <div className="detail-section">
            <h4>หัวข้อและหมวดหมู่</h4>
            <p className="case-subject">{c.subject}</p>
            <div className="tag-list">
              <span>{c.category}</span>
            </div>
          </div>
          {c.close_note && (
            <div className="detail-section">
              <h4>ผลการดูแล</h4>
              <p className="case-subject">{c.close_note}</p>
            </div>
          )}
          <div className="detail-section training-prompt">
            <span className="training-prompt-icon">
              <Sparkles size={21} />
            </span>
            <h4>เปลี่ยนคำตอบเป็นความรู้</h4>
            <p>
              คัดเลือกคำตอบที่ช่วยสมาชิกได้
              <br />
              เพื่อให้ AI เรียนรู้จากทีมของเรา
            </p>
            <button
              className="button full"
              disabled={busy || c.status !== 'CLOSED'}
              onClick={() =>
                run(
                  () => post(`/conversations/${id}/training`),
                  'สร้างฉบับร่างแล้ว ไปตรวจทานในชุดข้อมูล AI',
                )
              }
            >
              สร้างตัวอย่างฝึก <ArrowUpRight size={15} />
            </button>
            {c.status !== 'CLOSED' && <small>ใช้งานได้หลังปิดเคสที่แก้สำเร็จ</small>}
            {c.training_status && (
              <span className="badge neutral">มีตัวอย่าง: {c.training_status}</span>
            )}
          </div>
          <div className="detail-note">
            <ShieldCheck size={15} />
            <span>
              ข้อความและไฟล์แนบจัดเก็บในระบบ
              <br />
              ตรวจสอบการดำเนินการย้อนหลังได้
            </span>
          </div>
        </aside>
      )}
      {close && (
        <Modal
          title="ปิดเคสการดูแลสมาชิก"
          subtitle="ระบุผลและสรุปการช่วยเหลือ"
          onClose={() => setClose(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(
                () => post(`/conversations/${id}/close`, { resolution, note }),
                'ปิดเคสแล้ว',
              );
              if (ok) setClose(false);
            }}
          >
            <label>
              ผลการดูแล
              <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                <option value="RESOLVED_HUMAN">แก้ปัญหา / ให้ข้อมูลครบถ้วนแล้ว</option>
                <option value="UNRESOLVED">ยังแก้ไขไม่สำเร็จ</option>
                <option value="ABANDONED">สมาชิกไม่ได้ตอบกลับ</option>
              </select>
            </label>
            {resolution === 'UNRESOLVED' && (
              <div className="unresolved-transfer">
                <p>
                  หากยังต้องให้ทีมอื่นช่วย
                  สามารถโอนเคสพร้อมประวัติให้หน่วยงานที่เกี่ยวข้องดูแลต่อได้
                </p>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setClose(false);
                    setTransfer(true);
                  }}
                >
                  <Forward size={16} />
                  โอนไปหน่วยงานที่เกี่ยวข้อง
                </button>
              </div>
            )}
            <label>
              สรุปการช่วยเหลือ
              <textarea
                rows={4}
                required
                minLength={5}
                maxLength={2000}
                placeholder="ช่วยเหลืออย่างไร และสมาชิกได้รับคำตอบแล้วหรือไม่…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <div className="form-info">
              <Info size={16} />
              การปิดเคสบันทึกสถานะในระบบ หากต้องการแจ้งสมาชิก ให้ส่งข้อความก่อนปิดเคส
            </div>
            <div className="modal-footer">
              <button className="button" type="button" onClick={() => setClose(false)}>
                กลับไปสนทนา
              </button>
              <button className="button primary" disabled={busy || note.trim().length < 5}>
                ยืนยันปิดเคส <CheckCircle2 size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {transfer && (
        <TransferDialog
          conversation={c}
          initialReason={note}
          onClose={() => setTransfer(false)}
          onTransferred={async () => {
            await reload();
            onUpdate();
          }}
        />
      )}
      {history && (
        <Modal
          title={`ประวัติการโอนเคส #${String(c.number).padStart(4, '0')}`}
          subtitle="เส้นทางการดูแลและเหตุผลสำหรับทีมงาน"
          onClose={() => setHistory(false)}
        >
          <div className="transfer-history">
            {data.transfers.map((t) => (
              <article key={t.id}>
                <div>
                  <strong>
                    {t.from_team_name ?? 'คิวบริการส่วนกลาง'} → {t.to_team_name}
                  </strong>
                  <time>{formatDate(t.created_at)}</time>
                </div>
                <span>
                  ผู้ส่ง: {t.created_by_name} · ผู้รับ: {t.to_agent_name ?? 'คิวหน่วยงาน'}
                </span>
                <p>{t.reason}</p>
                <small>
                  {t.accepted_at
                    ? `${t.accepted_by_name} รับงานเมื่อ ${formatDate(t.accepted_at)}`
                    : 'ยังไม่มีการรับงานในการโอนครั้งนี้'}
                </small>
              </article>
            ))}
          </div>
        </Modal>
      )}
      {simulator && (
        <Modal
          title="ข้อความจากสมาชิก"
          subtitle={c.name + ' · ข้อความจำลอง'}
          onClose={() => setSimulator(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(
                () => post('/demo/message', { conversationId: id, text: incoming }),
                'รับข้อความจำลองแล้ว',
              );
              if (ok) {
                setSimulator(false);
                setIncoming('');
                setTimeout(reload, 1200);
              }
            }}
          >
            <label>
              ข้อความ
              <textarea
                rows={3}
                required
                value={incoming}
                onChange={(e) => setIncoming(e.target.value)}
              />
            </label>
            <div className="modal-footer">
              <button className="button primary" disabled={busy || !incoming.trim()}>
                ส่งข้อความจำลอง <Send size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
