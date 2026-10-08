import { useState } from 'react';
import { Bell, Check, Settings2 } from 'lucide-react';
import type { Agent } from '../../shared/types';
import { formatDate, go, notify, patch } from '../api';
import { Empty, ErrorBox, Loading, Modal, useResource } from '../components';

export const lineNoticeLabels: Record<string, string> = {
  NOT_CONFIGURED: 'LINE: ยังไม่เปิดใช้',
  PENDING: 'LINE: รอส่ง',
  ACCEPTED: 'LINE: รับคำขอแล้ว',
  SIMULATED: 'LINE: ส่งจำลองแล้ว',
  FAILED: 'LINE: ส่งไม่สำเร็จ',
  CANCELLED: 'LINE: ยกเลิกแล้ว',
};
type Staff = Agent & {
  active: boolean;
  line_user_id: string | null;
  line_alerts_enabled: boolean;
  line_identity_source: string | null;
};
type Notice = {
  id: string;
  title: string;
  conversation_id: string;
  agent_name: string;
  line_status: string;
  line_error: string | null;
  created_at: string;
};

export function LineNotificationsSettings({
  demo,
  loading,
}: {
  demo: boolean;
  loading: { enabled: boolean; seconds: number };
}) {
  const agents = useResource<Staff[]>('/agents'),
    notices = useResource<Notice[]>('/line-notifications', 5000);
  const [editing, setEditing] = useState<Staff | null>(null),
    [userId, setUserId] = useState(''),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState(false);
  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>
            <Bell size={19} />
            แจ้งเตือนเคสผ่าน LINE
          </h2>
          <p>ส่งเลขเคสและลิงก์ให้ผู้รับผิดชอบที่เปิดรับไว้</p>
        </div>
      </div>
      <p className="muted small-text">
        {demo
          ? 'ทดลองตั้งค่าและดูสถานะส่งจำลองได้'
          : 'เจ้าหน้าที่ต้องเพิ่ม LINE OA เป็นเพื่อนก่อนรับแจ้งเตือน'}
      </p>
      {agents.loading ? (
        <Loading />
      ) : agents.error ? (
        <ErrorBox message={agents.error} retry={agents.reload} />
      ) : (
        <div className="line-agent-list">
          {agents.data
            ?.filter((a) => a.active && a.role !== 'REVIEWER')
            .map((a) => (
              <div className="line-agent-row" key={a.id}>
                <div>
                  <strong>{a.name}</strong>
                  <span>
                    {a.line_alerts_enabled && a.line_user_id
                      ? 'เปิดรับแจ้งเตือนเคสส่งต่อ'
                      : 'ยังไม่เปิดรับแจ้งเตือน'}
                    {a.line_user_id ? ` · …${a.line_user_id.slice(-6)}` : ''}
                    {a.line_identity_source
                      ? ` · ยืนยันผ่าน ${a.line_identity_source === 'SSO' ? 'SSO' : 'LINE และ SSO'}`
                      : ''}
                  </span>
                </div>
                <button
                  className="button"
                  aria-label={`ตั้งค่า LINE ${a.name}`}
                  onClick={() => {
                    setEditing(a);
                    setUserId(a.line_user_id ?? '');
                    setEnabled(a.line_alerts_enabled);
                  }}
                >
                  <Settings2 size={15} />
                  ตั้งค่า LINE
                </button>
              </div>
            ))}
        </div>
      )}
      <div className="form-info">
        <Bell size={16} />
        <span>
          กำลังตอบ: {loading.enabled ? `${loading.seconds} วินาที` : 'ปิดอยู่'} ·
          แสดงเมื่อเปิดแชตส่วนตัวกับ OA
        </span>
      </div>
      <button
        className="text-button"
        onClick={() => {
          setHistory(true);
          void notices.reload();
        }}
      >
        ดูสถานะการแจ้งเตือนล่าสุด
      </button>
      {editing && (
        <Modal
          title="ตั้งค่า LINE ของเจ้าหน้าที่"
          subtitle={editing.name}
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await patch(`/agents/${editing.id}/line-notifications`, {
                  userId: userId.trim() || null,
                  enabled,
                });
                await agents.reload();
                await notices.reload();
                setEditing(null);
                notify('บันทึกการแจ้งเตือน LINE แล้ว');
              } catch (e) {
                notify((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              LINE User ID ของเจ้าหน้าที่
              <input
                value={userId}
                readOnly={Boolean(editing.line_identity_source)}
                onChange={(e) => setUserId(e.target.value)}
                required={enabled}
                pattern="U[0-9a-f]{32}"
                maxLength={33}
                placeholder="U ตามด้วยเลขฐานสิบหก 32 ตัว"
                autoComplete="off"
              />
            </label>
            <p className="muted small-text">
              ใช้ User ID จาก webhook เมื่อเจ้าหน้าที่ทัก OA นี้ ไม่ใช่ ID ค้นหาเพื่อน
              ตรวจบัญชีผู้รับก่อนบันทึก
            </p>
            <label className="switch-row">
              <div>
                <strong>รับแจ้งเตือนเคสส่งต่อ</strong>
                <span>มีผลกับเคสที่ส่งต่อหลังบันทึก</span>
              </div>
              <input
                type="checkbox"
                className="switch"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
            </label>
            <p className="muted small-text">
              เปลี่ยนบัญชีหรือปิดรับจะยกเลิก LINE ที่ยังรอส่ง ประวัติในเว็บยังอยู่
            </p>
            <div className="modal-footer">
              <button className="button primary" disabled={busy}>
                บันทึก LINE เจ้าหน้าที่ <Check size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {history && (
        <Modal
          title="สถานะการแจ้งเตือน LINE"
          subtitle="50 รายการล่าสุด · LINE รับคำขอไม่ได้ยืนยันการส่งถึงเครื่องหรือการอ่าน"
          wide
          onClose={() => setHistory(false)}
        >
          {notices.error ? (
            <ErrorBox message={notices.error} retry={notices.reload} />
          ) : !notices.data?.length ? (
            <Empty
              title="ยังไม่มีการโอนเคส"
              description="เมื่อโอนเคส ระบบจะแสดงสถานะการแจ้งเตือนแยกตามผู้รับ"
            />
          ) : (
            <div className="line-notice-list">
              {notices.data.map((n) => (
                <article className="line-notice-row" key={n.id}>
                  <div>
                    <strong>{n.title}</strong>
                    <p>
                      {n.agent_name} · {formatDate(n.created_at)}
                    </p>
                    <span
                      className={`badge ${['ACCEPTED', 'SIMULATED'].includes(n.line_status) ? 'approved' : 'neutral'}`}
                    >
                      {lineNoticeLabels[n.line_status]}
                    </span>
                    {n.line_error && <p className="muted small-text">{n.line_error}</p>}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => go(`/admin/inbox?case=${n.conversation_id}`)}
                  >
                    เปิดเคส
                  </button>
                </article>
              ))}
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
