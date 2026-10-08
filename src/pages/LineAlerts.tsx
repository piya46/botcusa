import { Bell, Copy, RefreshCw } from 'lucide-react';
import { formatDate, go, notify } from '../api';
import { Empty, ErrorBox, Loading, useResource } from '../components';

type Destination = { id: string; type: 'user' | 'group' | 'room' | null; configured: boolean };
type AlertData = {
  demo: boolean;
  tokenConfigured: boolean;
  agent: Destination;
  supervisor: Destination;
  chats: { id: string; type: 'group' | 'room'; active: boolean; last_event_at: string }[];
  jobs: {
    id: string;
    status: string;
    last_error: string | null;
    accepted: boolean | number;
    conversation_id: string | null;
    number: number | null;
    supervisor: string | null;
    created_at: string;
  }[];
};
const recipientLabels = { user: 'รายบุคคล', group: 'กลุ่ม', room: 'ห้องสนทนา' };
const jobLabels: Record<string, string> = {
  PENDING: 'รอส่ง / รอลองใหม่',
  RUNNING: 'กำลังส่ง',
  FAILED: 'ส่งไม่สำเร็จ',
  DONE: 'ประมวลผลแล้ว',
};

export function LineAlertsSettings() {
  const { data, error, loading, reload } = useResource<AlertData>('/line-alerts', 10000);
  return (
    <section className="panel settings-panel line-alert-settings">
      <div className="panel-heading">
        <div>
          <h2>
            <Bell size={19} />
            แจ้งเตือนคิวส่วนกลาง
          </h2>
          <p>ส่งเมื่อเคสเปลี่ยนเป็นรอเจ้าหน้าที่</p>
        </div>
        <button
          className="button"
          aria-label="รีเฟรชสถานะแจ้งเตือนส่วนกลาง"
          onClick={() => void reload()}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} retry={reload} />
      ) : (
        data && (
          <>
            {data.demo ? (
              <p className="muted small-text">โหมดทดลอง · ไม่มีการส่ง LINE จริง</p>
            ) : (
              !data.tokenConfigured && (
                <div className="form-info">ยังไม่ได้ตั้ง Channel access token บนเซิร์ฟเวอร์</div>
              )
            )}
            {(
              [
                ['เคสใหม่', data.agent],
                ['รอเกิน 5 นาที', data.supervisor],
              ] as const
            ).map(([label, target]) => (
              <div className="line-agent-row" key={label}>
                <div>
                  <strong>{label}</strong>
                  <span>
                    {!target.id
                      ? 'ยังไม่ได้ตั้งผู้รับ'
                      : target.configured
                        ? `ตั้งค่าแล้ว · ${target.type ? recipientLabels[target.type] : 'รูปแบบ ID ไม่ถูกต้อง'}`
                        : 'ตั้งผู้รับแล้ว แต่ยังไม่มี Channel access token'}
                  </span>
                  {target.id && <code>{target.id}</code>}
                </div>
              </div>
            ))}
            <p className="muted small-text">
              ตั้งผู้รับใน .env บน Plesk แล้ว Restart App: <code>LINE_AGENT_ALERT_USER_ID</code>{' '}
              สำหรับเคสใหม่ และ <code>LINE_SUPERVISOR_ALERT_USER_ID</code> สำหรับเคสเกิน 5 นาที
              รองรับ Group ID ขึ้นต้น C และ User ID ขึ้นต้น U
            </p>
            <details>
              <summary>ดู Group ID ที่ตรวจพบ ({data.chats.length})</summary>
              <p className="muted small-text">
                เปิด Allow bot to join group chats ใน LINE Developers เชิญ OA เข้ากลุ่ม
                แล้วส่งข้อความในกลุ่มเพื่อให้ระบบพบ ID ตรวจเวลาที่พบก่อนเลือกกลุ่ม
              </p>
              {data.chats.length === 0 ? (
                <Empty
                  title="ยังไม่พบกลุ่ม"
                  description="หลังอัปเดตระบบ ให้ส่งข้อความในกลุ่มที่มี OA แล้วกดรีเฟรช"
                />
              ) : (
                data.chats.map((chat) => (
                  <div className="line-agent-row" key={chat.id}>
                    <div>
                      <strong>
                        {recipientLabels[chat.type]} ·{' '}
                        {chat.active ? 'พบ OA ในกลุ่มล่าสุด' : 'OA ออกจากกลุ่มแล้ว'}
                      </strong>
                      <code>{chat.id}</code>
                      <span>{formatDate(chat.last_event_at)}</span>
                    </div>
                    <button
                      className="button"
                      aria-label={`คัดลอก ${chat.id}`}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(chat.id);
                          notify('คัดลอก ID แล้ว');
                        } catch {
                          notify('คัดลอกไม่สำเร็จ กรุณาเลือกและคัดลอก ID', 'error');
                        }
                      }}
                    >
                      <Copy size={15} />
                      คัดลอก
                    </button>
                  </div>
                ))
              )}
            </details>
            <details>
              <summary>สถานะแจ้งเตือนส่วนกลางล่าสุด</summary>
              {data.jobs.length === 0 ? (
                <Empty
                  title="ยังไม่มีงานแจ้งเตือน"
                  description="เคสจะเข้าคิวแจ้งเตือนเมื่อรอเจ้าหน้าที่"
                />
              ) : (
                data.jobs.map((job) => (
                  <div className="line-agent-row" key={job.id}>
                    <div>
                      <strong>
                        {job.supervisor === 'true' ? 'รอเกิน 5 นาที' : 'เคสใหม่'}{' '}
                        {job.number ? `#${String(job.number).padStart(4, '0')}` : ''}
                      </strong>
                      <span>
                        {job.accepted
                          ? data.demo
                            ? 'ส่งจำลองแล้ว'
                            : 'LINE รับคำขอแล้ว'
                          : (jobLabels[job.status] ?? job.status)}
                        {!job.accepted && job.last_error ? ` · ${job.last_error}` : ''}
                      </span>
                      <span>{formatDate(job.created_at)}</span>
                    </div>
                    {job.conversation_id && (
                      <button
                        className="button"
                        onClick={() => go(`/admin/inbox?case=${job.conversation_id}`)}
                      >
                        เปิดเคส
                      </button>
                    )}
                  </div>
                ))
              )}
              <p className="muted small-text">
                LINE รับคำขอแล้วไม่ใช่สถานะอ่าน ข้อมูลการส่งก่อนอัปเดตอาจแสดงเพียง “ประมวลผลแล้ว”
              </p>
            </details>
          </>
        )
      )}
    </section>
  );
}
