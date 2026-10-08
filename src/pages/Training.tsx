import { useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Database,
  Download,
  FileCheck2,
  FileText,
  GitBranch,
  Info,
  Layers,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { Agent, TrainingExample } from '../../shared/types';
import { formatDate, go, notify, patch, post } from '../api';
import { Empty, ErrorBox, Loading, Modal, PageTitle, useResource } from '../components';

const labels: Record<string, string> = {
  DRAFT: 'รอตรวจทาน',
  APPROVED: 'อนุมัติแล้ว',
  REJECTED: 'ไม่ผ่าน',
  REVOKED: 'ถอนข้อมูลแล้ว',
};
export function TrainingPage({ agent }: { agent: Agent }) {
  const { data, error, loading, reload } = useResource<TrainingExample[]>('/training', 8000),
    datasets = useResource<any[]>('/datasets');
  const [tab, setTab] = useState('DRAFT'),
    [selected, setSelected] = useState<TrainingExample | null>(null),
    [query, setQuery] = useState(''),
    [edit, setEdit] = useState(false),
    [question, setQuestion] = useState(''),
    [answer, setAnswer] = useState(''),
    [notes, setNotes] = useState(''),
    [privacy, setPrivacy] = useState(false),
    [quality, setQuality] = useState(false),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [name, setName] = useState('CUSA Member Support');
  const approved = data?.filter((e) => e.status === 'APPROVED').length ?? 0,
    drafts = data?.filter((e) => e.status === 'DRAFT').length ?? 0;
  const choose = (item: TrainingExample) => {
    setSelected(item);
    setQuestion(item.question);
    setAnswer(item.answer);
    setNotes(item.notes);
    setPrivacy(false);
    setQuality(false);
    setEdit(false);
  };
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      notify(message);
      await reload();
      return true;
    } catch (e) {
      notify((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page training-page">
      <PageTitle
        eyebrow="TRAINING STUDIO"
        title="ชุดข้อมูล AI"
        description="สอนวิธีตอบจากตัวอย่างที่อนุมัติ ให้ Gemini เรียบเรียงตามบุคลิกที่ตั้งไว้"
      >
        <button className="button" onClick={() => go('/admin/inbox?status=CLOSED')}>
          <MessageIcon />
          เลือกจากบทสนทนา
        </button>
        <button
          className="button primary"
          disabled={!approved || agent.role === 'AGENT'}
          onClick={() => setCreate(true)}
        >
          <Plus size={17} />
          สร้างชุดข้อมูล
        </button>
      </PageTitle>
      <div className="training-workflow">
        <div>
          <span className="workflow-step">
            <MessageIcon />
          </span>
          <div>
            <strong>คัดเลือกบทสนทนา</strong>
            <small>เคสที่แก้ปัญหาแล้ว</small>
          </div>
        </div>
        <ChevronRight size={18} />
        <div>
          <span className="workflow-step">
            <ShieldCheck size={20} />
          </span>
          <div>
            <strong>ตรวจทานข้อมูล</strong>
            <small>คำตอบถูกต้อง ปกปิดตัวตน</small>
          </div>
        </div>
        <ChevronRight size={18} />
        <div>
          <span className="workflow-step">
            <FileCheck2 size={20} />
          </span>
          <div>
            <strong>อนุมัติโดยผู้ตรวจทาน</strong>
            <small>คนละคนกับผู้จัดเตรียม</small>
          </div>
        </div>
        <ChevronRight size={18} />
        <div>
          <span className="workflow-step final">
            <Layers size={20} />
          </span>
          <div>
            <strong>ใช้ประกอบคำตอบ</strong>
            <small>เปิดใช้ในตั้งค่า AI · ส่งออกได้ด้วย</small>
          </div>
        </div>
      </div>
      <div className="training-summary">
        <div>
          <span className="metric-icon purple">
            <Sparkles size={19} />
          </span>
          <strong>{data?.length ?? 0}</strong>
          <span>ตัวอย่างทั้งหมด</span>
        </div>
        <div>
          <span className="metric-icon amber">
            <FileText size={19} />
          </span>
          <strong>{drafts}</strong>
          <span>รอตรวจทาน</span>
        </div>
        <div>
          <span className="metric-icon sage">
            <CheckCircle2 size={19} />
          </span>
          <strong>{approved}</strong>
          <span>ผ่านการอนุมัติ</span>
        </div>
        <div>
          <span className="metric-icon blue">
            <Layers size={19} />
          </span>
          <strong>{datasets.data?.length ?? 0}</strong>
          <span>เวอร์ชันชุดข้อมูล</span>
        </div>
      </div>
      <section className="panel">
        <div className="training-toolbar">
          <div className="tabs">
            {[
              ['DRAFT', 'รอตรวจทาน', drafts],
              ['APPROVED', 'อนุมัติแล้ว', approved],
              ['ALL', 'ทั้งหมด', data?.length ?? 0],
              ['DATASETS', 'ชุดข้อมูล', datasets.data?.length ?? 0],
            ].map(([value, label, count]) => (
              <button
                key={value}
                className={tab === value ? 'active' : ''}
                onClick={() => setTab(String(value))}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <div className="search-field">
            <Search size={16} />
            <input
              placeholder="ค้นหาตัวอย่าง…"
              aria-label="ค้นหาตัวอย่างฝึก"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox message={error} retry={reload} />
        ) : tab === 'DATASETS' ? (
          datasets.data?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ชุดข้อมูล</th>
                    <th>เวอร์ชัน</th>
                    <th>ตัวอย่าง</th>
                    <th>สร้างเมื่อ</th>
                    <th>ดาวน์โหลด JSONL</th>
                  </tr>
                </thead>
                <tbody>
                  {datasets.data.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <span className="table-main">
                          <Layers size={18} />
                          {d.name}
                        </span>
                      </td>
                      <td>
                        <span className="badge neutral">v{d.version}</span>
                      </td>
                      <td>
                        {d.example_count - d.revoked_count}
                        {d.revoked_count > 0 && <small> · ถอนแล้ว {d.revoked_count}</small>}
                      </td>
                      <td>{formatDate(d.created_at)}</td>
                      <td>
                        <div className="export-links">
                          {['train', 'validation', 'test'].map((split) => (
                            <a key={split} href={`/api/datasets/${d.id}/export?split=${split}`}>
                              <Download size={13} />
                              {split}
                            </a>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="ยังไม่มีชุดข้อมูล"
              description="อนุมัติตัวอย่าง แล้วกดสร้างชุดข้อมูลเพื่อบันทึกเวอร์ชัน"
            />
          )
        ) : (
          <div className="table-wrap">
            <table className="training-table">
              <thead>
                <tr>
                  <th>คำถามและคำตอบ</th>
                  <th>หมวดหมู่</th>
                  <th>ต้นทาง</th>
                  <th>สถานะ</th>
                  <th>ผู้จัดเตรียม</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data
                  ?.filter(
                    (e) =>
                      (tab === 'ALL' || e.status === tab) &&
                      `${e.question} ${e.answer}`.includes(query),
                  )
                  .map((ex) => (
                    <tr key={ex.id} onClick={() => choose(ex)} className="clickable-row">
                      <td>
                        <button className="question-cell" onClick={() => choose(ex)}>
                          <strong>{ex.question}</strong>
                          <span>{ex.answer}</span>
                        </button>
                      </td>
                      <td>
                        <span className="category-label">{ex.category}</span>
                      </td>
                      <td>
                        <span className="case-reference">
                          #{String(ex.case_number).padStart(4, '0')}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`badge ${ex.status === 'APPROVED' ? 'approved' : ex.status === 'DRAFT' ? 'pending' : 'neutral'}`}
                        >
                          <i />
                          {labels[ex.status]}
                        </span>
                      </td>
                      <td>{ex.created_by_name.split(' · ')[0]}</td>
                      <td>
                        <ArrowUpRight size={17} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!data?.some(
              (e) =>
                (tab === 'ALL' || e.status === tab) && `${e.question} ${e.answer}`.includes(query),
            ) && (
              <Empty
                title="ยังไม่มีตัวอย่างในรายการนี้"
                description="สร้างตัวอย่างจากเคสที่ปิดแล้ว หรือเปลี่ยนตัวกรอง"
              />
            )}
          </div>
        )}
      </section>
      <div className="dataset-note">
        <GitBranch size={18} />
        <div>
          <strong>แบ่งชุดข้อมูลตามบทสนทนา</strong>
          <p>
            ตัวอย่างจากเคสเดียวกันอยู่ในชุดเดียวกันเสมอ เพื่อแยกข้อมูลฝึกและข้อมูลทดสอบอย่างชัดเจน
          </p>
        </div>
        <span className="subtle-pill">Train / Validation / Test</span>
      </div>
      {selected && (
        <Modal
          title="ตรวจทานตัวอย่างฝึก"
          subtitle={`เคส #${String(selected.case_number).padStart(4, '0')} · ${selected.category}`}
          wide
          onClose={() => setSelected(null)}
        >
          <div className="review-top">
            <span className={`badge ${selected.status === 'APPROVED' ? 'approved' : 'pending'}`}>
              {labels[selected.status]}
            </span>
            <button
              className="text-button"
              onClick={() => {
                setSelected(null);
                go(`/admin/inbox?case=${selected.conversation_id}`);
              }}
            >
              ดูบทสนทนาต้นทาง <ArrowUpRight size={14} />
            </button>
          </div>
          {edit ? (
            <>
              <label>
                คำถาม
                <textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
              </label>
              <label>
                คำตอบที่เหมาะสม
                <textarea rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} />
              </label>
              <label>
                หมายเหตุการแก้ไข
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
            </>
          ) : (
            <>
              <div className="review-block">
                <span>คำถามของสมาชิก</span>
                <p>{selected.question}</p>
              </div>
              <div className="review-block answer">
                <span>
                  <Sparkles size={13} /> คำตอบสำหรับใช้ฝึก
                </span>
                <p>{selected.answer}</p>
              </div>
              {selected.context.length > 1 && (
                <details className="context-details">
                  <summary>บริบทก่อนคำตอบ · {selected.context.length} ข้อความ</summary>
                  {selected.context.map((m, i) => (
                    <p key={i}>
                      <b>{m.role === 'user' ? 'สมาชิก' : 'ผู้ตอบ'}:</b> {m.content}
                    </p>
                  ))}
                </details>
              )}
              {selected.notes && <p className="muted">หมายเหตุ: {selected.notes}</p>}
            </>
          )}
          <div className="form-info">
            <ShieldCheck size={17} />
            <span>
              ระบบช่วยปกปิดข้อมูลเบื้องต้น ผู้ตรวจทานต้องตรวจชื่อ ที่อยู่
              และข้อมูลระบุตัวตนที่อาจยังหลงเหลือ
            </span>
          </div>
          {selected.status === 'DRAFT' && !edit && (
            <div className="review-checks">
              <label>
                <input
                  type="checkbox"
                  checked={privacy}
                  onChange={(e) => setPrivacy(e.target.checked)}
                />
                ตรวจแล้วว่าไม่มีข้อมูลส่วนบุคคลที่ไม่ควรใช้ฝึก
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={quality}
                  onChange={(e) => setQuality(e.target.checked)}
                />
                ตรวจความถูกต้องของคำตอบและบริบทแล้ว
              </label>
            </div>
          )}
          {selected.created_by === agent.id && selected.status === 'DRAFT' && (
            <p className="review-warning">
              <Info size={15} />
              ให้ผู้ตรวจทานอีกคนอนุมัติตัวอย่างนี้
              {agent.role === 'ADMIN' ? ' · ในพื้นที่ทดลอง สลับบัญชีได้ที่มุมซ้ายล่าง' : ''}
            </p>
          )}
          <div className="modal-footer">
            {selected.status === 'APPROVED' && agent.role !== 'AGENT' && (
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  const ok = await run(
                    () => post(`/training/${selected.id}/retire`, {}),
                    'เลิกใช้ตัวอย่างแล้ว',
                  );
                  if (ok) {
                    setSelected(null);
                    void datasets.reload();
                  }
                }}
              >
                เลิกใช้ตัวอย่างนี้
              </button>
            )}
            {selected.status === 'DRAFT' ? (
              edit ? (
                <>
                  <button className="button" onClick={() => setEdit(false)}>
                    ยกเลิก
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={async () => {
                      const ok = await run(
                        () => patch(`/training/${selected.id}`, { question, answer, notes }),
                        'บันทึกฉบับร่างแล้ว',
                      );
                      if (ok) setSelected(null);
                    }}
                  >
                    บันทึกฉบับร่าง <Check size={16} />
                  </button>
                </>
              ) : (
                <>
                  <button className="button" onClick={() => setEdit(true)}>
                    <Pencil size={15} />
                    แก้ไข
                  </button>
                  <div className="flex-spacer" />
                  <button
                    className="button"
                    disabled={busy || agent.role === 'AGENT' || selected.created_by === agent.id}
                    onClick={async () => {
                      const ok = await run(
                        () => post(`/training/${selected.id}/review`, { approve: false }),
                        'บันทึกผลไม่ผ่านแล้ว',
                      );
                      if (ok) setSelected(null);
                    }}
                  >
                    ไม่ผ่าน
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      busy ||
                      !privacy ||
                      !quality ||
                      agent.role === 'AGENT' ||
                      selected.created_by === agent.id
                    }
                    onClick={async () => {
                      const ok = await run(
                        () =>
                          post(`/training/${selected.id}/review`, {
                            approve: true,
                            privacyReviewed: true,
                            qualityReviewed: true,
                          }),
                        'อนุมัติตัวอย่างแล้ว',
                      );
                      if (ok) setSelected(null);
                    }}
                  >
                    อนุมัติตัวอย่าง <CheckCircle2 size={16} />
                  </button>
                </>
              )
            ) : (
              <button className="button" onClick={() => setSelected(null)}>
                ปิดหน้าต่าง
              </button>
            )}
          </div>
        </Modal>
      )}
      {create && (
        <Modal
          title="สร้างเวอร์ชันชุดข้อมูล"
          subtitle="บันทึกตัวอย่างที่อนุมัติแล้วเป็นชุดข้อมูลพร้อมส่งออก"
          onClose={() => setCreate(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => post('/datasets', { name }), 'สร้างเวอร์ชันชุดข้อมูลแล้ว');
              if (ok) {
                setCreate(false);
                setTab('DATASETS');
                void datasets.reload();
              }
            }}
          >
            <label>
              ชื่อชุดข้อมูล
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                minLength={3}
                required
              />
            </label>
            <div className="dataset-preview">
              <Layers size={24} />
              <div>
                <strong>{approved} ตัวอย่างที่ผ่านการตรวจทาน</strong>
                <span>เก็บ snapshot พร้อมแหล่งที่มาและผู้อนุมัติ</span>
              </div>
            </div>
            <p className="muted">
              รูปแบบ JSONL กลาง รองรับการนำไปปรับ Prompt, RAG และแปลงต่อสำหรับโมเดลที่รองรับ
              fine-tuning
            </p>
            <div className="modal-footer">
              <button type="button" className="button" onClick={() => setCreate(false)}>
                ยกเลิก
              </button>
              <button className="button primary" disabled={busy}>
                สร้างชุดข้อมูล <ArrowRight size={16} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function MessageIcon() {
  return <FileText size={18} />;
}
