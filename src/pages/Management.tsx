import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clock3,
  Code2,
  Database,
  Edit3,
  ExternalLink,
  FileText,
  Info,
  KeyRound,
  Link2,
  LockKeyhole,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Unlink,
  Users,
  Wifi,
} from 'lucide-react';
import type { Agent, Knowledge } from '../../shared/types';
import { formatDate, notify, patch, post } from '../api';
import { Avatar, Empty, ErrorBox, Loading, Modal, PageTitle, useResource } from '../components';
import { MemberActions, menuStatus } from './MemberActions';
import { KnowledgeDocuments } from './KnowledgeDocuments';
import { LineNotificationsSettings } from './LineNotifications';
import {
  AudienceFields,
  AudienceSummary,
  emptyFilters,
  useAudiencePreview,
} from './AudienceFields';

const categories = [
  'ทั่วไป',
  'ข้อมูลสมาชิก',
  'บัญชีและการเข้าสู่ระบบ',
  'กิจกรรมศิษย์เก่า',
  'สิทธิประโยชน์',
];
export function KnowledgePage({ agent }: { agent: Agent }) {
  const { data, error, loading, reload } = useResource<Knowledge[]>('/knowledge'),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('ALL'),
    [document, setDocument] = useState(''),
    [selectedId, setSelectedId] = useState(new URLSearchParams(location.search).get('id') ?? ''),
    [editing, setEditing] = useState<Knowledge | null | undefined>(undefined),
    [title, setTitle] = useState(''),
    [content, setContent] = useState(''),
    [category, setCategory] = useState('ทั่วไป'),
    [keywords, setKeywords] = useState(''),
    [busy, setBusy] = useState(false);
  const open = (item: Knowledge | null) => {
    setEditing(item);
    setTitle(item?.title ?? '');
    setContent(item?.content ?? '');
    setCategory(item?.category ?? 'ทั่วไป');
    setKeywords(item?.keywords.join(', ') ?? '');
  };
  return (
    <div className="page">
      <PageTitle eyebrow="KNOWLEDGE BASE" title="ฐานความรู้" description="คำตอบและคู่มือสำหรับบอท">
        <button className="button primary" onClick={() => open(null)}>
          <Plus size={17} />
          เพิ่มความรู้
        </button>
      </PageTitle>
      <div className="knowledge-banner">
        <div className="knowledge-banner-icon">
          <BookOpen size={28} />
        </div>
        <div>
          <h3>ตรวจทานก่อนเผยแพร่</h3>
          <p>ผู้ตรวจทานอีกคนอนุมัติ · บอทใช้ฉบับเผยแพร่ล่าสุด</p>
        </div>
        <div className="knowledge-count">
          <strong>
            {data?.filter((k) => k.published_content && k.status !== 'ARCHIVED').length ?? 0}
          </strong>
          <span>รายการพร้อมใช้</span>
        </div>
      </div>
      <KnowledgeDocuments
        agent={agent}
        selected={document}
        onSelect={(id) => {
          setDocument(id);
          setSelectedId('');
        }}
        onChange={reload}
      />
      {selectedId && (
        <button className="text-button" onClick={() => setSelectedId('')}>
          แสดงความรู้ทั้งหมด
        </button>
      )}
      <div className="content-toolbar">
        <div className="tabs">
          {[
            ['ALL', 'ทั้งหมด'],
            ['PUBLISHED', 'เผยแพร่แล้ว'],
            ['DRAFT', 'ฉบับร่าง'],
            ['ARCHIVED', 'เก็บถาวร'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="search-field">
          <Search size={16} />
          <input
            placeholder="ค้นหาความรู้…"
            aria-label="ค้นหาฐานความรู้"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} retry={reload} />
      ) : (
        <div className="knowledge-grid">
          {data
            ?.filter(
              (k) =>
                (filter === 'ALL' || k.status === filter) &&
                (!document || k.document_id === document) &&
                (!selectedId || k.id === selectedId) &&
                `${k.title} ${k.content}`.includes(search),
            )
            .map((k) => (
              <article className="knowledge-card" key={k.id}>
                <div className="knowledge-card-top">
                  <span className="document-icon">
                    <FileText size={21} />
                  </span>
                  <span className={`badge ${k.status === 'PUBLISHED' ? 'approved' : 'pending'}`}>
                    <i />
                    {k.status === 'PUBLISHED'
                      ? 'เผยแพร่แล้ว'
                      : k.status === 'ARCHIVED'
                        ? 'เก็บถาวร'
                        : 'ฉบับร่าง'}
                  </span>
                </div>
                <span className="eyebrow">{k.category}</span>
                <h3>{k.title}</h3>
                <p>{k.content}</p>
                {k.document_id && (
                  <a
                    className="text-button"
                    href={`/api/knowledge/documents/${k.document_id}/source`}
                  >
                    ต้นฉบับ · หน้า {k.source_page}
                  </a>
                )}
                <div className="tag-list">
                  {k.keywords.slice(0, 3).map((word) => (
                    <span key={word}>{word}</span>
                  ))}
                </div>
                <div className="knowledge-card-footer">
                  <span>
                    เวอร์ชัน {k.version} · {formatDate(k.updated_at, true)}
                  </span>
                  <button
                    className="text-button"
                    disabled={k.status === 'ARCHIVED'}
                    onClick={() => open(k)}
                  >
                    แก้ไข <Edit3 size={14} />
                  </button>
                </div>
                {k.status === 'DRAFT' && (
                  <button
                    className="button full"
                    disabled={busy || agent.role === 'AGENT'}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await post(`/knowledge/${k.id}/publish`);
                        notify('อนุมัติและเผยแพร่ความรู้แล้ว');
                        await reload();
                      } catch (e) {
                        notify((e as Error).message, 'error');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <ShieldCheck size={15} />
                    ตรวจทานและเผยแพร่
                  </button>
                )}
                {k.status !== 'ARCHIVED' && agent.role !== 'AGENT' && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await post(`/knowledge/${k.id}/archive`);
                        await reload();
                        notify('เก็บความรู้ถาวรแล้ว บอทจะไม่ใช้รายการนี้');
                      } catch (e) {
                        notify((e as Error).message, 'error');
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    เก็บถาวร
                  </button>
                )}
              </article>
            ))}
        </div>
      )}
      {!loading && !data?.length && (
        <Empty title="ยังไม่มีความรู้" description="เพิ่มคำถามและคำตอบที่สมาชิกสอบถามบ่อย" />
      )}
      {editing !== undefined && (
        <Modal
          title={editing ? 'แก้ไขความรู้' : 'เพิ่มความรู้ใหม่'}
          subtitle="บันทึกเป็นฉบับร่าง แล้วส่งให้ผู้ตรวจทานอีกคนอนุมัติ"
          wide
          onClose={() => setEditing(undefined)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const body = {
                  title,
                  content,
                  category,
                  keywords: keywords
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                };
                if (editing) await patch(`/knowledge/${editing.id}`, body);
                else await post('/knowledge', body);
                notify('บันทึกฉบับร่างแล้ว');
                setEditing(undefined);
                await reload();
              } catch (e) {
                notify((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              หัวข้อ / คำถาม
              <input
                value={title}
                required
                minLength={3}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="สมาชิกจะยืนยันตัวตนได้อย่างไร?"
              />
            </label>
            <label>
              คำตอบที่เป็นทางการ
              <textarea
                rows={7}
                value={content}
                required
                minLength={10}
                maxLength={12000}
                onChange={(e) => setContent(e.target.value)}
                placeholder="ระบุขั้นตอน เงื่อนไข และข้อมูลอ้างอิง…"
              />
            </label>
            <div className="form-columns">
              <label>
                หมวดหมู่
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                คำค้นหา (คั่นด้วยจุลภาค)
                <input
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="ยืนยันตัวตน, SSO, Google"
                />
              </label>
            </div>
            <div className="modal-footer">
              <button type="button" className="button" onClick={() => setEditing(undefined)}>
                ยกเลิก
              </button>
              <button className="button primary" disabled={busy}>
                บันทึกฉบับร่าง <Check size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function MembersPage({ agent }: { agent: Agent }) {
  const [search, setSearch] = useState(''),
    [unlink, setUnlink] = useState<any>(null),
    [manage, setManage] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useResource<any[]>(
    `/members?search=${encodeURIComponent(search)}`,
    5000,
  );
  return (
    <div className="page">
      <PageTitle eyebrow="MEMBER DIRECTORY" title="สมาชิก" description="บัญชี CUSA และสถานะ LINE">
        <span className="date-pill">
          <Users size={16} />
          {data?.length ?? 0} สมาชิก
        </span>
      </PageTitle>
      <div className="directory-summary">
        <div>
          <span className="metric-icon sage">
            <ShieldCheck size={20} />
          </span>
          <div>
            <strong>{data?.filter((u) => u.cusa_sub).length ?? 0}</strong>
            <span>ผูกบัญชี CUSA แล้ว</span>
          </div>
        </div>
        <div>
          <span className="metric-icon amber">
            <Link2 size={20} />
          </span>
          <div>
            <strong>{data?.filter((u) => !u.cusa_sub).length ?? 0}</strong>
            <span>ยังไม่ผูกบัญชี</span>
          </div>
        </div>
        <div className="directory-note">
          <LockKeyhole size={20} />
          <p>
            ข้อมูลสมาชิกจาก SSO ใช้ตามสิทธิ์ที่ได้รับ
            <br />
            การผูกบัญชีไม่ใช่เซสชันอนุญาตเข้าถึงบริการ
          </p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>รายชื่อสมาชิก</h2>
          <div className="search-field">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาชื่อหรืออีเมล…"
              aria-label="ค้นหาสมาชิก"
            />
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox message={error} retry={reload} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>สมาชิก</th>
                  <th>สังกัด</th>
                  <th>การยืนยันตัวตน</th>
                  <th>บทสนทนา</th>
                  <th>Rich Menu / ความสนใจ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="member-cell">
                        <Avatar name={u.name} color={u.avatar_color} />
                        <div>
                          <strong>{u.name}</strong>
                          <span>{u.email ?? 'ยังไม่ได้แบ่งปันอีเมล'}</span>
                        </div>
                      </div>
                    </td>
                    <td>{u.department ?? '—'}</td>
                    <td>
                      <span className={`badge ${u.cusa_sub ? 'approved' : 'neutral'}`}>
                        <ShieldCheck size={12} />
                        {u.cusa_sub ? 'ผูกบัญชีแล้ว' : 'ผู้เยี่ยมชม'}
                      </span>
                    </td>
                    <td>{u.conversations} เคส</td>
                    <td>
                      <span
                        className={`badge ${u.rich_menu_status === 'FAILED' ? 'failed' : 'neutral'}`}
                      >
                        {menuStatus[u.rich_menu_status] ?? 'ยังไม่มีคำสั่ง'}
                      </span>
                      <span className="audience-summary">
                        {u.interest_tags?.join(' · ') || 'ยังไม่ระบุความสนใจ'}
                      </span>
                    </td>
                    <td>
                      {agent.role === 'ADMIN' && (
                        <button
                          className="icon-button"
                          aria-label={`จัดการสมาชิก ${u.name}`}
                          title="จัดการสมาชิก"
                          onClick={() => setManage(u)}
                        >
                          <Settings size={17} />
                        </button>
                      )}
                      {u.cusa_sub && agent.role === 'ADMIN' && (
                        <button
                          className="icon-button"
                          aria-label={`ยกเลิกผูกบัญชี ${u.name}`}
                          title="ยกเลิกผูกบัญชี"
                          onClick={() => setUnlink(u)}
                        >
                          <Unlink size={17} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data?.length && <Empty title="ไม่พบสมาชิก" description="ลองใช้คำค้นหาอื่น" />}
          </div>
        )}
      </section>
      {manage && (
        <MemberActions
          member={data?.find((u) => u.id === manage.id) ?? manage}
          onClose={() => setManage(null)}
          onUpdate={reload}
        />
      )}
      {unlink && (
        <Modal title="ยกเลิกการผูกบัญชี" subtitle={unlink.name} onClose={() => setUnlink(null)}>
          <p className="muted">
            ข้อมูลเชื่อมโยง CUSA จะถูกล้าง และเปลี่ยนกลับเป็นเมนูผู้เยี่ยมชมหรือเมนูเริ่มต้นของ OA
            สมาชิกสามารถยืนยันตัวตนใหม่ได้
          </p>
          <div className="modal-footer">
            <button className="button" onClick={() => setUnlink(null)}>
              ยกเลิก
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await post(`/members/${unlink.id}/unlink`);
                  notify('ยกเลิกผูกบัญชีแล้ว');
                  setUnlink(null);
                  await reload();
                } catch (e) {
                  notify((e as Error).message, 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              ยืนยันยกเลิกผูกบัญชี
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const broadcastLabels: Record<string, string> = {
  DRAFT: 'ฉบับร่าง',
  SCHEDULED: 'ตั้งเวลาแล้ว',
  SENDING: 'กำลังส่ง',
  COMPLETED: 'API รับครบแล้ว',
  FAILED: 'พบข้อผิดพลาด',
  CANCELLED: 'ยกเลิกแล้ว',
};
export function BroadcastPage({ agent, demo }: { agent: Agent; demo: boolean }) {
  const { data, error, loading, reload } = useResource<any[]>('/broadcasts', 5000);
  const runtime = useResource<{ workerMode: 'continuous' | 'opportunistic' }>('/runtime');
  const [create, setCreate] = useState(false),
    [title, setTitle] = useState(''),
    [content, setContent] = useState(''),
    [segment, setSegment] = useState('all'),
    [filters, setFilters] = useState(emptyFilters),
    [send, setSend] = useState<any>(null),
    [schedule, setSchedule] = useState(''),
    [busy, setBusy] = useState(false);
  const preview = useAudiencePreview(
    send?.segment ?? segment,
    send?.filters ?? filters,
    create || Boolean(send),
  );
  return (
    <div className="page">
      <PageTitle
        eyebrow="BROADCASTS"
        title="บรอดแคสต์"
        description="เลือกกลุ่ม · เขียนข้อความ · ตั้งเวลาส่ง"
      >
        <button
          className="button primary"
          disabled={agent.role !== 'ADMIN'}
          onClick={() => setCreate(true)}
        >
          <Plus size={17} />
          สร้างบรอดแคสต์
        </button>
      </PageTitle>
      <div className="broadcast-banner">
        <span>
          <Send size={25} />
        </span>
        <div>
          <h3>ข้อความที่เกี่ยวข้อง สู่คนที่ใช่</h3>
          <p>เลือกสถานะสมาชิก สังกัด บทบาท และหัวข้อความสนใจ พร้อมตรวจจำนวนผู้รับก่อนส่ง</p>
        </div>
        <div className="quota-note">
          <Info size={16} />
          โควตา LINE นับตามจำนวนผู้รับ
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>รายการบรอดแคสต์</h2>
          <span className="subtle-pill">{data?.length ?? 0} รายการ</span>
        </div>
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox message={error} retry={reload} />
        ) : !data?.length ? (
          <Empty
            title="ยังไม่มีบรอดแคสต์"
            description="สร้างข้อความและเลือกผู้รับ"
            action={
              agent.role === 'ADMIN' ? (
                <button className="button" onClick={() => setCreate(true)}>
                  <Plus size={16} />
                  สร้างบรอดแคสต์แรก
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ข้อความ</th>
                  <th>กลุ่มเป้าหมาย</th>
                  <th>สถานะ</th>
                  <th>ผู้รับ</th>
                  <th>เวลาส่ง</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <div className="broadcast-text">
                        <strong>{b.title}</strong>
                        <span>{b.content}</span>
                      </div>
                    </td>
                    <td>
                      {b.segment === 'all'
                        ? 'ทุกคน'
                        : b.segment === 'members'
                          ? 'สมาชิก CUSA'
                          : 'ผู้เยี่ยมชม'}
                      <AudienceSummary filters={b.filters} />
                    </td>
                    <td>
                      <span
                        className={`badge ${b.status === 'COMPLETED' ? 'approved' : b.status === 'FAILED' ? 'failed' : 'neutral'}`}
                      >
                        {demo && b.status === 'COMPLETED'
                          ? 'จำลองส่งครบแล้ว'
                          : broadcastLabels[b.status]}
                      </span>
                    </td>
                    <td>{b.recipient_count || '—'}</td>
                    <td>{b.scheduled_at ? formatDate(b.scheduled_at) : 'ยังไม่กำหนด'}</td>
                    <td>
                      {b.status === 'DRAFT' && agent.role === 'ADMIN' && (
                        <button
                          className="button small"
                          onClick={() => {
                            setSend(b);
                            setSchedule('');
                          }}
                        >
                          ตรวจและส่ง <ArrowRight size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {create && (
        <Modal
          title="สร้างบรอดแคสต์"
          subtitle="บันทึกเป็นฉบับร่างก่อนตรวจและส่ง"
          wide
          onClose={() => setCreate(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post('/broadcasts', { title, content, segment, filters });
                notify('บันทึกฉบับร่างแล้ว');
                setCreate(false);
                setTitle('');
                setContent('');
                setFilters(emptyFilters());
                await reload();
              } catch (e) {
                notify((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              ชื่อรายการ (ทีมงานเห็นเท่านั้น)
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                minLength={3}
                maxLength={150}
                placeholder="เชิญร่วมกิจกรรมศิษย์เก่า"
              />
            </label>
            <label>
              กลุ่มเป้าหมาย
              <select value={segment} onChange={(e) => setSegment(e.target.value)}>
                <option value="all">ทุกคนในระบบ</option>
                <option value="members">สมาชิกที่ผูกบัญชี CUSA</option>
                <option value="guests">ผู้เยี่ยมชมที่ยังไม่ผูกบัญชี</option>
              </select>
            </label>
            <AudienceFields value={filters} onChange={setFilters} />
            <label>
              ข้อความที่สมาชิกจะได้รับ
              <textarea
                rows={7}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
                minLength={3}
                maxLength={4500}
                placeholder="สวัสดีสมาชิก CUSA ทุกท่าน…"
              />
            </label>
            <div className="modal-footer">
              <span className="muted" role="status">
                {preview.error ||
                  (preview.count === null
                    ? 'กำลังนับผู้รับ…'
                    : `กลุ่มนี้มี ${preview.count} ผู้รับในระบบ`)}
              </span>
              <div className="flex-spacer" />
              <button className="button primary" disabled={busy}>
                บันทึกฉบับร่าง <Check size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {send && (
        <Modal title="ตรวจข้อความก่อนส่ง" subtitle={send.title} onClose={() => setSend(null)}>
          <div className="broadcast-preview">{send.content}</div>
          <div className="form-info">
            <Users size={17} />
            {preview.error ||
              (preview.count === null ? 'กำลังนับผู้รับ…' : `${preview.count} ผู้รับ`)}{' '}
            · {demo ? 'จำลองการส่งในพื้นที่ทดลอง' : 'ใช้โควตา LINE ตามจำนวนผู้รับ'}
          </div>
          <AudienceSummary filters={send.filters} />
          <p className="muted small-text">
            ตรวจจำนวนอีกครั้งและบันทึกรายชื่อผู้รับเมื่อยืนยัน
            กลุ่มที่ตั้งเวลาจะใช้รายชื่อนี้ในการส่ง
          </p>
          <label>
            ตั้งเวลาส่ง (เวลาไทย — เว้นว่างเพื่อส่งทันที)
            <input
              type="datetime-local"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </label>
          {runtime.data?.workerMode === 'opportunistic' && (
            <p className="form-info" role="note">
              โฮสต์นี้ส่งงานเมื่อแอปทำงาน หากแอปพัก ข้อความจะรอจนมีคนเปิดเว็บหรือมี LINE เข้ามา
            </p>
          )}
          <div className="modal-footer">
            <button className="button" onClick={() => setSend(null)}>
              กลับไปตรวจ
            </button>
            <button
              className="button primary"
              disabled={
                busy || preview.count === null || preview.count === 0 || Boolean(preview.error)
              }
              onClick={async () => {
                setBusy(true);
                try {
                  await post(
                    `/broadcasts/${send.id}/send`,
                    schedule ? { scheduledAt: new Date(`${schedule}:00+07:00`).toISOString() } : {},
                  );
                  notify(schedule ? 'ตั้งเวลาส่งแล้ว' : 'นำข้อความเข้าคิวส่งแล้ว');
                  setSend(null);
                  await reload();
                } catch (e) {
                  notify((e as Error).message, 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {schedule ? 'ยืนยันตั้งเวลา' : demo ? 'จำลองส่งทันที' : 'ยืนยันส่งทันที'}
              <Send size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { data, error, loading, reload } = useResource<any>('/settings'),
    audit = useResource<any[]>('/audit');
  const [prompt, setPrompt] = useState(''),
    [enabled, setEnabled] = useState(false),
    [notice, setNotice] = useState(''),
    [purpose, setPurpose] = useState(''),
    [busy, setBusy] = useState(false),
    [addAgent, setAddAgent] = useState(false),
    [agentName, setAgentName] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [role, setRole] = useState('AGENT'),
    [settingsTab, setSettingsTab] = useState('connections');
  useEffect(() => {
    if (data) {
      setPrompt(data.settings.system_prompt);
      setEnabled(data.settings.training_policy.enabled);
      setNotice(data.settings.training_policy.notice_version);
      setPurpose(data.settings.training_policy.purpose);
    }
  }, [data]);
  if (loading) return <Loading />;
  if (error || !data)
    return (
      <div className="page">
        <ErrorBox message={error} retry={reload} />
      </div>
    );
  return (
    <div className="page">
      <PageTitle
        eyebrow="WORKSPACE SETTINGS"
        title="ตั้งค่าระบบ"
        description="LINE · AI · เจ้าหน้าที่ · นโยบายข้อมูล"
      >
        <button hidden={!data.demo} className="button" onClick={() => setAddAgent(true)}>
          <Plus size={16} />
          เพิ่มเจ้าหน้าที่
        </button>
        <button
          hidden={settingsTab !== 'ai'}
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await patch('/settings', {
                system_prompt: prompt,
                training_policy: { enabled, notice_version: notice, purpose },
              });
              notify('บันทึกการตั้งค่าแล้ว');
              await reload();
              void audit.reload();
            } catch (e) {
              notify((e as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          บันทึกการตั้งค่า <Check size={16} />
        </button>
      </PageTitle>
      <div className="content-toolbar">
        <div className="tabs" aria-label="หมวดตั้งค่า">
          {[
            ['connections', 'LINE และการเชื่อมต่อ'],
            ['ai', 'AI และข้อมูล'],
            ['audit', 'ประวัติระบบ'],
          ].map(([id, label]) => (
            <button
              key={id}
              className={settingsTab === id ? 'active' : ''}
              onClick={() => setSettingsTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        className={`settings-grid ${settingsTab === 'ai' ? 'settings-ai-view' : ''}`}
        hidden={settingsTab === 'audit'}
      >
        <div>
          {settingsTab === 'connections' && (
            <LineNotificationsSettings demo={data.demo} loading={data.lineLoading} />
          )}
          <section className="panel settings-panel" hidden={settingsTab !== 'ai'}>
            <div className="panel-heading">
              <div>
                <h2>
                  <Sparkles size={19} />
                  คำสั่งผู้ช่วย AI
                </h2>
                <p>กำหนดบทบาท ภาษา และขอบเขตข้อมูล</p>
              </div>
            </div>
            <label className="sr-only" htmlFor="system-prompt">
              System prompt
            </label>
            <textarea
              id="system-prompt"
              className="prompt-editor"
              rows={7}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="form-info">
              <BookOpen size={16} />
              ใช้ความรู้ที่อนุมัติแล้ว · ไม่พบคำตอบจะส่งต่อเจ้าหน้าที่
            </div>
          </section>
          <section className="panel settings-panel" hidden={settingsTab !== 'ai'}>
            <div className="panel-heading">
              <div>
                <h2>
                  <ShieldCheck size={19} />
                  การเตรียมชุดข้อมูลฝึก
                </h2>
                <p>กำหนดวัตถุประสงค์และการใช้งานข้อมูลก่อนเริ่มคัดเลือก</p>
              </div>
            </div>
            <label className="switch-row">
              <div>
                <strong>เปิดใช้งาน Training Studio</strong>
                <span>สร้างและอนุมัติตัวอย่างฝึก</span>
              </div>
              <input
                type="checkbox"
                className="switch"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
            </label>
            <label>
              เวอร์ชันประกาศการใช้ข้อมูล
              <input
                value={notice}
                onChange={(e) => setNotice(e.target.value)}
                placeholder="เช่น member-ai-improvement-v1"
              />
            </label>
            <label>
              วัตถุประสงค์
              <textarea rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
            </label>
            <div className="retention-row">
              <span>
                ประวัติสนทนา <b>{data.chatRetentionDays} วัน</b>
              </span>
              <span>
                เวอร์ชันชุดข้อมูล <b>{data.datasetRetentionDays} วัน</b>
              </span>
            </div>
            <p className="muted small-text">
              การถอนข้อความต้นทางจะถอนตัวอย่างและ snapshot ที่เกี่ยวข้องด้วย อายุเก็บกำหนดผ่าน
              environment ของเซิร์ฟเวอร์
            </p>
          </section>
        </div>
        <div hidden={settingsTab !== 'connections'}>
          {!data.demo && (
            <div className="form-info">
              เจ้าหน้าที่ใช้ CUSA SSO · กำหนดบทบาท admin, agent หรือ reviewer ที่ CUSA
              รายชื่อจะแสดงหลังเข้าใช้ครั้งแรก
            </div>
          )}
          <section className="panel settings-panel">
            <div className="panel-heading">
              <h2>
                <Wifi size={18} />
                การเชื่อมต่อ
              </h2>
            </div>
            {[
              ['LINE Messaging API', data.integrations.line],
              ['CUSA SSO · v1.5.0', data.integrations.sso],
              ['Gemini', data.integrations.gemini],
              ['แจ้งเตือน Supervisor', data.supervisorAlertsConfigured],
              ['แจ้งเตือนเคสใหม่ส่วนกลาง', data.agentAlertsConfigured],
            ].map(([name, connected]) => (
              <div className="integration-row" key={String(name)}>
                <strong>{name}</strong>
                <span className={`badge ${connected ? 'approved' : 'neutral'}`}>
                  <i />
                  {connected ? 'ตั้งค่าแล้ว' : 'ยังไม่เชื่อมต่อ'}
                </span>
              </div>
            ))}
            <div className="integration-row">
              <strong>Database</strong>
              <span>{data.integrations.database}</span>
            </div>
            <p className="muted small-text">
              ตั้งค่าคีย์ใน .env แล้วเริ่มแอปใหม่ สถานะนี้ยังไม่ยืนยันการเชื่อมต่อจริง
            </p>
            <label>
              LINE Webhook URL
              <div className="copy-field">
                <code>{data.webhookUrl}</code>
                <button
                  className="icon-button"
                  aria-label="คัดลอก Webhook URL"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(data.webhookUrl)
                      .then(() => notify('คัดลอก URL แล้ว'))
                      .catch(() => notify('คัดลอกไม่สำเร็จ', 'error'));
                  }}
                >
                  <FileText size={16} />
                </button>
              </div>
            </label>
            <label>
              CUSA Callback URL
              <div className="copy-field">
                <code>{data.callbackUrl}</code>
                <button
                  className="icon-button"
                  aria-label="คัดลอก Callback URL"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(data.callbackUrl)
                      .then(() => notify('คัดลอก URL แล้ว'))
                      .catch(() => notify('คัดลอกไม่สำเร็จ', 'error'));
                  }}
                >
                  <FileText size={16} />
                </button>
              </div>
            </label>
          </section>
          <section className="panel settings-panel">
            <div className="panel-heading">
              <h2>
                <Database size={18} />
                สถานะงานเบื้องหลัง
              </h2>
            </div>
            <div className="job-status">
              <strong>{data.failedJobs}</strong>
              <span>งานที่ต้องตรวจสอบ</span>
            </div>
            {data.workerMode === 'opportunistic' && (
              <p className="muted small-text">
                ทำงานเมื่อแอปตื่น · งานตั้งเวลาและแจ้งเตือนอาจล่าช้าช่วงโฮสต์พัก
              </p>
            )}
            {data.settings.worker_heartbeat?.at && (
              <p className="muted small-text">
                ทำงานล่าสุด {formatDate(data.settings.worker_heartbeat.at)}
              </p>
            )}
          </section>
        </div>
      </div>
      <section className="panel audit-panel" hidden={settingsTab !== 'audit'}>
        <div className="panel-heading">
          <div>
            <h2>บันทึกการดำเนินการ</h2>
            <p>รายการล่าสุดสำหรับตรวจสอบย้อนหลัง</p>
          </div>
          <ShieldCheck size={19} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เวลา</th>
                <th>ผู้ดำเนินการ</th>
                <th>การดำเนินการ</th>
                <th>ประเภท</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.slice(0, 15).map((log) => (
                <tr key={log.id}>
                  <td>{formatDate(log.created_at)}</td>
                  <td>{log.agent_name ?? 'ระบบ'}</td>
                  <td>
                    <code>{log.action}</code>
                  </td>
                  <td>{log.entity_type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {addAgent && (
        <Modal
          title="เพิ่มบัญชีเจ้าหน้าที่"
          subtitle="บัญชีนี้ใช้เข้าสู่ Member Desk และมีสิทธิ์ตามบทบาทที่เลือก"
          onClose={() => setAddAgent(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post('/agents', { name: agentName, email, password, role });
                notify('สร้างบัญชีเจ้าหน้าที่แล้ว');
                setAddAgent(false);
                setPassword('');
                void audit.reload();
              } catch (e) {
                notify((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              ชื่อ
              <input
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                required
                minLength={2}
              />
            </label>
            <label>
              อีเมล
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              รหัสผ่าน (อย่างน้อย 12 ตัวอักษร)
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={12}
              />
            </label>
            <label>
              บทบาท
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="AGENT">เจ้าหน้าที่ — ดูแลเคสและเตรียมข้อมูล</option>
                <option value="REVIEWER">ผู้ตรวจทาน — อนุมัติความรู้และชุดข้อมูล</option>
                <option value="ADMIN">ผู้ดูแลระบบ — จัดการทุกส่วน</option>
              </select>
            </label>
            <div className="modal-footer">
              <button className="button primary" disabled={busy}>
                สร้างบัญชี <Plus size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
