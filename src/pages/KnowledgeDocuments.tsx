import { useEffect, useRef, useState } from 'react';
import { Archive, FileUp, Download, FileText } from 'lucide-react';
import type { Agent } from '../../shared/types';
import { api, formatDate, notify, post } from '../api';
import { ErrorBox, Modal, useResource } from '../components';

type Document = {
  id: string;
  title: string;
  filename: string;
  status: string;
  pages: number | null;
  empty_pages: number;
  chunks: number;
  published: number;
  error: string | null;
  created_at: string;
};
export function KnowledgeDocuments({
  agent,
  selected,
  onSelect,
  onChange,
}: {
  agent: Agent;
  selected: string;
  onSelect: (id: string) => void;
  onChange: () => void;
}) {
  const { data, error, reload } = useResource<Document[]>('/knowledge/documents', 4000);
  const previous = useRef('');
  const revision =
    data?.map((d) => `${d.id}:${d.status}:${d.chunks}:${d.published}`).join('|') ?? '';
  useEffect(() => {
    if (previous.current && revision !== previous.current) onChange();
    previous.current = revision;
  }, [revision, onChange]);
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [title, setTitle] = useState(''),
    [category, setCategory] = useState('ทั่วไป'),
    [file, setFile] = useState<File | null>(null);
  return (
    <section className="panel document-panel">
      <div className="panel-heading">
        <div>
          <h2>คู่มือและเอกสารอ้างอิง</h2>
          <p>นำเข้าเป็นฉบับร่าง แยกตามหน้าและส่วนของเนื้อหา</p>
        </div>
        <button className="button" onClick={() => setOpen(true)}>
          <FileUp size={17} />
          อัปโหลดคู่มือ
        </button>
      </div>
      {error && <ErrorBox message={error} retry={reload} />}
      {!data?.length && !error && (
        <p className="panel-footnote">
          รองรับ PDF ที่มีข้อความ และ TXT · สูงสุด 8 MB / 60 หน้า · PDF สแกนต้องทำ OCR ก่อน
        </p>
      )}
      <div className="document-list">
        {data?.map((doc) => (
          <article className="document-row" key={doc.id}>
            <FileText size={22} />
            <div className="document-info">
              <strong>{doc.title}</strong>
              <span>
                {doc.filename} · {formatDate(doc.created_at, true)}
              </span>
              <p>
                {doc.status === 'QUEUED'
                  ? 'กำลังอ่านเอกสาร…'
                  : doc.status === 'FAILED'
                    ? doc.error
                    : doc.status === 'ARCHIVED'
                      ? 'เก็บถาวรแล้ว — บอทไม่ใช้งาน'
                      : `${doc.pages} หน้า · ${doc.chunks} ส่วน · เผยแพร่ ${doc.published} ส่วน`}
              </p>
              {doc.empty_pages > 0 && (
                <p className="form-error">
                  มี {doc.empty_pages} หน้าที่อ่านไม่พบข้อความ กรุณาตรวจต้นฉบับ
                </p>
              )}
            </div>
            <div className="document-actions">
              <a
                className="icon-button"
                href={`/api/knowledge/documents/${doc.id}/source`}
                aria-label={`ดาวน์โหลด ${doc.title}`}
              >
                <Download size={17} />
              </a>
              {doc.chunks > 0 && (
                <button
                  className={`button ${selected === doc.id ? 'primary' : ''}`}
                  onClick={() => {
                    onSelect(selected === doc.id ? '' : doc.id);
                    onChange();
                  }}
                >
                  {selected === doc.id ? 'แสดงความรู้ทั้งหมด' : 'ตรวจเนื้อหา'}
                </button>
              )}
              {doc.status !== 'ARCHIVED' && agent.role !== 'AGENT' && (
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label={`เก็บถาวร ${doc.title}`}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await post(`/knowledge/documents/${doc.id}/archive`);
                      await reload();
                      onChange();
                      notify('เก็บเอกสารและเนื้อหาทุกส่วนถาวรแล้ว');
                    } catch (e) {
                      notify((e as Error).message, 'error');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Archive size={17} />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {open && (
        <Modal
          title="อัปโหลดคู่มือ"
          subtitle="ทุกส่วนต้องผ่านผู้ตรวจทานอีกคนก่อนนำไปตอบสมาชิก"
          onClose={() => setOpen(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!file) return;
              setBusy(true);
              try {
                if (file.size > 8 * 1024 * 1024) throw new Error('ไฟล์ต้องไม่เกิน 8 MB');
                const form = new FormData();
                form.append('title', title);
                form.append('category', category);
                form.append('file', file);
                await api('/knowledge/documents', { method: 'POST', body: form });
                setOpen(false);
                setFile(null);
                setTitle('');
                await reload();
                onChange();
                notify('รับไฟล์แล้ว กำลังสร้างฉบับร่าง');
              } catch (e) {
                notify((e as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              ชื่อคู่มือ
              <input
                required
                minLength={3}
                maxLength={160}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              หมวดหมู่เอกสาร
              <input
                required
                maxLength={100}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
            <label>
              ไฟล์ PDF หรือ TXT
              <input
                type="file"
                accept=".pdf,.txt"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <p className="panel-footnote">
              PDF ไม่เกิน 60 หน้า / 8 MB และ TXT แบบ UTF-8 ระบบเก็บต้นฉบับไว้ให้ตรวจอ้างอิง
              กรุณาตรวจข้อมูลส่วนบุคคลก่อนเผยแพร่
            </p>
            <div className="modal-footer">
              <button className="button primary" disabled={busy}>
                {busy ? 'กำลังอัปโหลด…' : 'นำเข้าเป็นฉบับร่าง'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
