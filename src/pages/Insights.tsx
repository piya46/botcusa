import { useState } from 'react';
import { ArrowUpRight, BookPlus, Sparkles } from 'lucide-react';
import type { Agent } from '../../shared/types';
import { formatDate, go, notify, post } from '../api';
import { Empty, ErrorBox, Loading, Modal, PageTitle, useResource } from '../components';

type Gap = {
  id: string;
  conversation_id: string;
  case_number: number;
  question: string;
  reason: string;
  status: string;
  knowledge_id: string | null;
};
type Analysis = {
  conversation_id: string;
  case_number: number;
  case_status: string;
  resolution: string | null;
  status: string | null;
  model: string | null;
  error: string | null;
  analyzed_at: string | null;
  coverage: { selected: number; total: number; truncated: boolean } | null;
  result: {
    intent: string;
    summary: string;
    sentiment: string;
    outcome: string;
    interest_tags: string[];
  } | null;
};
const sentiment: Record<string, string> = {
  positive: 'เชิงบวก',
  neutral: 'เป็นกลาง',
  negative: 'เชิงลบ',
  unknown: 'ข้อมูลไม่พอ',
};
const outcomes: Record<string, string> = {
  resolved: 'มีหลักฐานว่าแก้สำเร็จ',
  unresolved: 'ยังไม่สำเร็จ',
  escalated: 'ส่งต่อเจ้าหน้าที่',
  unknown: 'ข้อมูลไม่พอ',
};
const reasons: Record<string, string> = {
  NO_KNOWLEDGE: 'ไม่พบความรู้ที่ใช้ตอบ',
  MODEL_UNCERTAIN: 'โมเดลตอบจากหลักฐานไม่ได้',
  AI_SUGGESTED: 'AI เสนอให้ตรวจสอบ',
};
export function InsightsPage({ agent }: { agent: Agent }) {
  const { data, error, loading, reload } = useResource<{
    enabled: boolean;
    gaps: Gap[];
    analyses: Analysis[];
  }>('/insights', 5000);
  const [tab, setTab] = useState('gaps'),
    [filter, setFilter] = useState('OPEN'),
    [editing, setEditing] = useState<Gap | null>(null),
    [title, setTitle] = useState(''),
    [answer, setAnswer] = useState(''),
    [busy, setBusy] = useState(false);
  const action = async (path: string) => {
    setBusy(true);
    try {
      await post(path);
      await reload();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <PageTitle
        eyebrow="CONVERSATION INSIGHTS"
        title="คำถามค้างและผลวิเคราะห์"
        description="เติมคำตอบที่ขาด · ตรวจผลวิเคราะห์ AI"
      />
      <div className="knowledge-banner">
        <div className="knowledge-banner-icon">
          <Sparkles size={27} />
        </div>
        <div>
          <h3>{data?.gaps.filter((g) => g.status === 'OPEN').length ?? 0} คำถามรอทีมเติมคำตอบ</h3>
          <p>เติมคำตอบ แล้วส่งให้ผู้ตรวจทานอนุมัติ</p>
        </div>
      </div>
      <div className="content-toolbar">
        <div className="tabs">
          <button className={tab === 'gaps' ? 'active' : ''} onClick={() => setTab('gaps')}>
            คำถามรอเติมความรู้
          </button>
          <button className={tab === 'analyses' ? 'active' : ''} onClick={() => setTab('analyses')}>
            วิเคราะห์หลังจบเคส
          </button>
        </div>
        {tab === 'gaps' && (
          <select
            aria-label="สถานะคำถามค้าง"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="OPEN">รอเติมคำตอบ</option>
            <option value="DRAFTED">สร้างฉบับร่างแล้ว</option>
            <option value="DISMISSED">ไม่ต้องเพิ่มความรู้</option>
          </select>
        )}
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} retry={reload} />
      ) : tab === 'gaps' ? (
        <div className="insight-list">
          {data?.gaps
            .filter((g) => g.status === filter)
            .map((g) => (
              <article className="panel insight-card" key={g.id}>
                <div className="insight-meta">
                  <span className="eyebrow">CASE #{g.case_number}</span>
                  <span className="badge pending">{reasons[g.reason]}</span>
                </div>
                <h3>{g.question}</h3>
                <div className="insight-actions">
                  <button
                    className="text-button"
                    onClick={() => go(`/admin/inbox?case=${g.conversation_id}`)}
                  >
                    อ่านบทสนทนา <ArrowUpRight size={15} />
                  </button>
                  {g.status === 'OPEN' && (
                    <>
                      <button
                        className="button primary"
                        onClick={() => {
                          setEditing(g);
                          setTitle(g.question.slice(0, 200));
                          setAnswer('');
                        }}
                      >
                        <BookPlus size={16} />
                        เติมคำตอบ
                      </button>
                      {agent.role !== 'AGENT' && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => action(`/insights/gaps/${g.id}/dismiss`)}
                        >
                          ไม่ต้องเพิ่มความรู้
                        </button>
                      )}
                    </>
                  )}
                  {g.knowledge_id && (
                    <button
                      className="button"
                      onClick={() => go(`/admin/knowledge?id=${g.knowledge_id}`)}
                    >
                      ตรวจฉบับร่าง
                    </button>
                  )}
                </div>
              </article>
            ))}
          {!data?.gaps.some((g) => g.status === filter) && (
            <Empty
              title="ไม่มีคำถามในรายการนี้"
              description="คำถามที่บอทไม่พบความรู้จะเข้ารายการโดยอัตโนมัติ"
            />
          )}
        </div>
      ) : (
        <>
          <div className="insight-notice">
            <strong>
              {data?.enabled
                ? 'ผลจาก AI เป็นข้อเสนอแนะสำหรับตรวจทาน'
                : 'ยังไม่เปิดใช้การวิเคราะห์ AI'}
            </strong>
            <p>
              {data?.enabled
                ? 'วิเคราะห์เมื่อปิดเคสหรือไม่มีข้อความใหม่ 30 นาที ใช้เฉพาะข้อความสนทนาที่ปกปิดข้อมูลระบุตัวตนเบื้องต้น ผลไม่เปลี่ยนสถานะเคสหรือข้อมูลสมาชิก'
                : 'โหมดทดลองแสดงเฉพาะข้อมูลจริงในระบบ เมื่อตั้งค่า AI ในโหมดจริงแล้วจึงเริ่มวิเคราะห์ได้'}
            </p>
            <p>
              ไม่รวมบันทึกภายในและไฟล์แนบ · แสดงเคสล่าสุด 100 เคส ·
              มีข้อความใหม่จะรอวิเคราะห์อีกครั้ง
            </p>
          </div>
          <div className="insight-list">
            {data?.analyses.map((a) => (
              <article className="panel insight-card" key={a.conversation_id}>
                <div className="insight-meta">
                  <button
                    className="text-button"
                    onClick={() => go(`/admin/inbox?case=${a.conversation_id}`)}
                  >
                    เคส #{a.case_number} <ArrowUpRight size={15} />
                  </button>
                  <span>{a.case_status === 'CLOSED' ? 'ปิดเคสแล้ว' : 'หยุดสนทนาชั่วคราว'}</span>
                </div>
                {a.status === 'READY' && a.result ? (
                  <>
                    <h3>{a.result.intent}</h3>
                    <p className="insight-summary">{a.result.summary}</p>
                    <div className="tag-list">
                      <span>ความรู้สึก: {sentiment[a.result.sentiment]}</span>
                      <span>AI ประเมิน: {outcomes[a.result.outcome]}</span>
                      {a.result.interest_tags.map((t) => (
                        <span key={t}>สนใจ: {t}</span>
                      ))}
                    </div>
                    <p className="panel-footnote">
                      {a.model} · {a.analyzed_at && formatDate(a.analyzed_at)} · ใช้{' '}
                      {a.coverage?.selected}/{a.coverage?.total} ข้อความ
                      {a.coverage?.truncated ? ' (ตัดเนื้อหาบางส่วน)' : ''}
                    </p>
                  </>
                ) : (
                  <p>
                    {a.status === 'QUEUED' ? 'รอประมวลผล…' : (a.error ?? 'ยังไม่มีผลวิเคราะห์')}
                  </p>
                )}
                {data.enabled &&
                  agent.role !== 'AGENT' &&
                  a.status !== 'READY' &&
                  a.status !== 'QUEUED' && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => action(`/insights/conversations/${a.conversation_id}/analyze`)}
                    >
                      {a.status === 'FAILED' ? 'ลองวิเคราะห์อีกครั้ง' : 'วิเคราะห์เคส'}
                    </button>
                  )}
              </article>
            ))}
          </div>
        </>
      )}
      {editing && (
        <Modal
          title="เติมคำตอบจากคำถามค้าง"
          subtitle="เขียนคำตอบที่ยืนยันแล้วและตรวจข้อมูลส่วนบุคคลก่อนบันทึก"
          wide
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post(`/insights/gaps/${editing.id}/draft`, {
                  title,
                  content: answer,
                  category: 'ทั่วไป',
                  keywords: [],
                });
                setEditing(null);
                await reload();
                notify('สร้างฉบับร่างแล้ว รอผู้ตรวจทานอีกคนอนุมัติ');
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
                required
                minLength={3}
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              คำตอบที่ตรวจสอบแล้ว
              <textarea
                required
                rows={7}
                minLength={10}
                maxLength={12000}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </label>
            <div className="modal-footer">
              <button className="button primary" disabled={busy}>
                สร้างฉบับร่าง
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
