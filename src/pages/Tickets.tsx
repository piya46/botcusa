import { useState } from 'react';
import { ArrowRight, Building2, Bell, Plus, Search, Settings, Ticket, Users } from 'lucide-react';
import type { Agent, Conversation, Team } from '../../shared/types';
import { formatDate, go, notify, patch, post, relative } from '../api';
import { Empty, ErrorBox, Loading, Modal, PageTitle, Status, useResource } from '../components';
import { lineNoticeLabels } from './LineNotifications';

export function TransferDialog({
  conversation,
  initialReason = '',
  onClose,
  onTransferred,
}: {
  conversation: Conversation;
  initialReason?: string;
  onClose: () => void;
  onTransferred: () => Promise<unknown>;
}) {
  const teams = useResource<Team[]>('/teams');
  const [teamId, setTeamId] = useState(''),
    [agentId, setAgentId] = useState(''),
    [reason, setReason] = useState(initialReason),
    [busy, setBusy] = useState(false);
  const [requestId] = useState(crypto.randomUUID());
  const selected = teams.data?.find((t) => t.id === teamId);
  return (
    <Modal
      title={`โอนเคส #${String(conversation.number).padStart(4, '0')}`}
      subtitle="เลือกหน่วยงาน ผู้รับผิดชอบ และเหตุผล"
      onClose={onClose}
    >
      {teams.loading ? (
        <Loading />
      ) : teams.error ? (
        <ErrorBox message={teams.error} retry={teams.reload} />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await post(`/conversations/${conversation.id}/transfer`, {
                teamId,
                agentId: agentId || null,
                reason,
                requestId,
                expectedVersion: conversation.routing_version,
              });
              await onTransferred();
              notify('โอนเคสและแจ้งเตือนผู้รับในระบบแล้ว');
              onClose();
            } catch (e) {
              notify((e as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            หน่วยงานปลายทาง
            <select
              required
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value);
                setAgentId('');
              }}
            >
              <option value="">เลือกหน่วยงานที่เกี่ยวข้อง</option>
              {teams.data
                ?.filter((t) => t.active && t.members.length)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          {selected?.description && <p className="muted small-text">{selected.description}</p>}
          <label>
            ผู้รับผิดชอบปลายทาง
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={!selected}
            >
              <option value="">รอเจ้าหน้าที่ในหน่วยงานรับงาน</option>
              {selected?.members.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            เหตุผลและสิ่งที่ต้องดำเนินการต่อ
            <textarea
              required
              minLength={10}
              maxLength={2000}
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="ตรวจสอบอะไรแล้ว เหตุใดจึงยังแก้ไม่ได้ และต้องการให้ทีมปลายทางช่วยเรื่องใด…"
            />
          </label>
          <div className="form-info">
            <Ticket size={18} />
            เก็บเลขเคสและประวัติสนทนาเดิม
            ผู้รับปลายทางจะได้รับการแจ้งเตือนในระบบและกดรับเคสก่อนตอบสมาชิก เหตุผลนี้เห็นเฉพาะทีมงาน
          </div>
          {!teams.data?.some((t) => t.active && t.members.length) && (
            <p className="muted small-text">
              ให้ผู้ดูแลเพิ่มหน่วยงานและเจ้าหน้าที่ในหน้า Tickets ก่อนโอนเคส
            </p>
          )}
          <div className="modal-footer">
            <button type="button" className="button" onClick={onClose}>
              กลับไปดูเคส
            </button>
            <button
              className="button primary"
              disabled={busy || !selected || reason.trim().length < 10}
            >
              ยืนยันโอนเคส <ArrowRight size={16} />
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function TicketsPage({ agent }: { agent: Agent }) {
  const teams = useResource<Team[]>('/teams');
  const [teamId, setTeamId] = useState(''),
    [mine, setMine] = useState(false),
    [status, setStatus] = useState('OPEN'),
    [search, setSearch] = useState(''),
    [manage, setManage] = useState(false);
  const tickets = useResource<Conversation[]>(
    `/tickets?status=${status}&mine=${mine}&search=${encodeURIComponent(search)}${teamId ? `&teamId=${teamId}` : ''}`,
    4000,
  );
  return (
    <div className="page">
      <PageTitle
        eyebrow="SERVICE TICKETS"
        title="เคสและการส่งต่อ"
        description="ติดตามงานตามหน่วยงานและผู้รับผิดชอบ"
      >
        {agent.role === 'ADMIN' && (
          <button className="button" onClick={() => setManage(true)}>
            <Building2 size={17} />
            จัดการหน่วยงาน
          </button>
        )}
      </PageTitle>
      <div className="ticket-filters">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="ค้นหา Ticket"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="เลขเคส หัวข้อ หรือสมาชิก…"
          />
        </div>
        <select
          aria-label="หน่วยงานที่รับผิดชอบ"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
        >
          <option value="">ทุกหน่วยงาน</option>
          {teams.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          aria-label="สถานะ Ticket"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="OPEN">เคสที่ยังเปิดอยู่</option>
          <option value="WAITING_FOR_AGENT">รอรับงาน</option>
          <option value="AGENT_IN_CHARGE">กำลังดูแล</option>
          <option value="CLOSED">ปิดแล้ว</option>
          <option value="ALL">ทุกสถานะ</option>
        </select>
        <label className="ticket-mine">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          งานของฉันและคิวทีม
        </label>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <Ticket size={18} /> รายการเคส
          </h2>
          <span className="subtle-pill">{tickets.data?.length ?? 0} เคส</span>
        </div>
        {tickets.loading ? (
          <Loading />
        ) : tickets.error ? (
          <ErrorBox message={tickets.error} retry={tickets.reload} />
        ) : !tickets.data?.length ? (
          <Empty title="ไม่มีเคสในกลุ่มนี้" description="ลองเลือกหน่วยงานหรือสถานะอื่น" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>เคส / สมาชิก</th>
                  <th>หน่วยงาน</th>
                  <th>ผู้รับผิดชอบ</th>
                  <th>สถานะ</th>
                  <th>ส่งต่อ / รอรับ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tickets.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="broadcast-text">
                        <strong>
                          #{String(c.number).padStart(4, '0')} · {c.subject}
                        </strong>
                        <span>{c.name}</span>
                      </div>
                    </td>
                    <td>{c.team_name ?? 'คิวบริการส่วนกลาง'}</td>
                    <td>{c.assigned_agent_name ?? 'รอทีมรับงาน'}</td>
                    <td>
                      <Status state={c.status} />
                      {c.routing_version > 0 && (
                        <span className="audience-summary">โอนแล้ว {c.routing_version} ครั้ง</span>
                      )}
                    </td>
                    <td>{c.handover_at ? relative(c.handover_at) : '—'}</td>
                    <td>
                      <button
                        className="button small"
                        onClick={() => go(`/admin/inbox?case=${c.id}`)}
                      >
                        เปิดเคส <ArrowRight size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="panel-footnote">แสดงสูงสุด 200 เคส เรียงเคสเร่งด่วนและเคสที่รอนานก่อน</p>
      </section>
      {manage && <TeamsDialog onClose={() => setManage(false)} onUpdate={teams.reload} />}
    </div>
  );
}

function TeamsDialog({
  onClose,
  onUpdate,
}: {
  onClose: () => void;
  onUpdate: () => Promise<unknown>;
}) {
  const teams = useResource<Team[]>('/teams'),
    agents = useResource<(Agent & { active: boolean })[]>('/agents');
  const [editing, setEditing] = useState<string | null | undefined>(undefined),
    [name, setName] = useState(''),
    [description, setDescription] = useState(''),
    [memberIds, setMemberIds] = useState<string[]>([]),
    [active, setActive] = useState(true),
    [busy, setBusy] = useState(false);
  function edit(team?: Team) {
    setEditing(team?.id ?? null);
    setName(team?.name ?? '');
    setDescription(team?.description ?? '');
    setMemberIds(team?.members.map((a) => a.id) ?? []);
    setActive(team?.active ?? true);
  }
  return (
    <Modal
      title="หน่วยงานและผู้รับผิดชอบ"
      subtitle="กำหนดทีมปลายทางสำหรับรับ Ticket ภายในองค์กร"
      onClose={onClose}
    >
      {teams.loading || agents.loading ? (
        <Loading />
      ) : teams.error || agents.error ? (
        <ErrorBox
          message={teams.error || agents.error}
          retry={() => {
            void teams.reload();
            void agents.reload();
          }}
        />
      ) : editing === undefined ? (
        <>
          <div className="team-list">
            {teams.data?.map((t) => (
              <button key={t.id} className="team-row" onClick={() => edit(t)}>
                <Building2 size={20} />
                <span>
                  <strong>{t.name}</strong>
                  <small>
                    {t.members.map((a) => a.name.split(' · ')[0]).join(', ')}
                    {!t.active ? ' · ปิดรับงาน' : ''}
                  </small>
                </span>
                <Settings size={17} />
              </button>
            ))}
          </div>
          <div className="modal-footer">
            <button className="button primary" onClick={() => edit()}>
              <Plus size={16} />
              เพิ่มหน่วยงาน
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const body = { name, description, memberIds, active };
              await (editing ? patch(`/teams/${editing}`, body) : post('/teams', body));
              await teams.reload();
              await onUpdate();
              setEditing(undefined);
              notify('บันทึกหน่วยงานแล้ว');
            } catch (e) {
              notify((e as Error).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            ชื่อหน่วยงาน
            <input
              required
              minLength={2}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            ขอบเขตงาน
            <textarea
              rows={2}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <fieldset className="team-members">
            <legend>เจ้าหน้าที่ในหน่วยงาน</legend>
            {agents.data
              ?.filter((a) => a.active && a.role !== 'REVIEWER')
              .map((a) => (
                <label key={a.id}>
                  <input
                    type="checkbox"
                    checked={memberIds.includes(a.id)}
                    onChange={(e) =>
                      setMemberIds(
                        e.target.checked
                          ? [...memberIds, a.id]
                          : memberIds.filter((id) => id !== a.id),
                      )
                    }
                  />
                  {a.name}
                </label>
              ))}
          </fieldset>
          <label className="ticket-mine">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            เปิดรับเคสใหม่
          </label>
          <div className="modal-footer">
            <button type="button" className="button" onClick={() => setEditing(undefined)}>
              กลับไปรายการ
            </button>
            <button className="button primary" disabled={busy || !memberIds.length}>
              บันทึกหน่วยงาน
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function TicketNotifications() {
  const notices = useResource<{
    unread: number;
    items: {
      id: string;
      title: string;
      conversation_id: string;
      read_at: string | null;
      created_at: string;
      status: Conversation['status'];
      line_status: string;
    }[];
  }>('/notifications', 5000);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="icon-button ticket-notification"
        aria-label={`การแจ้งเตือนเคส ${notices.data?.unread ?? 0} รายการใหม่`}
        onClick={() => {
          setOpen(true);
          void notices.reload();
        }}
      >
        <Bell size={20} />
        {Boolean(notices.data?.unread) && <b>{Math.min(99, notices.data!.unread)}</b>}
      </button>
      {open && (
        <Modal
          title="การแจ้งเตือนเคส"
          subtitle="งานที่ส่งถึงคุณหรือหน่วยงานของคุณ"
          onClose={() => setOpen(false)}
        >
          {notices.error ? (
            <ErrorBox message={notices.error} retry={notices.reload} />
          ) : !notices.data?.items.length ? (
            <Empty title="ยังไม่มีงานส่งต่อใหม่" description="เคสที่ส่งถึงคุณจะแสดงที่นี่" />
          ) : (
            <div className="team-list">
              {notices.data.items.map((n) => (
                <button
                  className={`team-row ${n.read_at ? '' : 'unread'}`}
                  key={n.id}
                  onClick={async () => {
                    try {
                      await post(`/notifications/${n.id}/read`);
                      await notices.reload();
                      setOpen(false);
                      go(`/admin/inbox?case=${n.conversation_id}`);
                    } catch (e) {
                      notify((e as Error).message, 'error');
                    }
                  }}
                >
                  <Ticket size={20} />
                  <span>
                    <strong>{n.title}</strong>
                    <small>{formatDate(n.created_at)}</small>
                    <small>{lineNoticeLabels[n.line_status]}</small>
                  </span>
                  <Status state={n.status} />
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
