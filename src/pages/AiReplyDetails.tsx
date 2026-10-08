import { BookOpen } from 'lucide-react';
import type { Message } from '../../shared/types';

const reasons: Record<string, string> = {
  USER_REQUEST: 'ผู้ใช้ขอคุยกับเจ้าหน้าที่',
  NON_TEXT: 'ข้อความประเภทนี้ต้องให้เจ้าหน้าที่ดูแล',
  VERIFICATION_REQUIRED: 'ต้องตรวจข้อมูลส่วนบุคคลกับเจ้าหน้าที่',
  NO_KNOWLEDGE: 'ไม่พบความรู้ที่ตรง หรือถามรายละเอียดครบแล้ว',
  MODEL_UNCERTAIN: 'AI ไม่ยืนยันคำตอบหรืออ้างอิงไม่ถูกต้อง',
  PROVIDER_ERROR: 'เรียก AI ไม่สำเร็จ',
};

export function AiReplyDetails({ message }: { message: Message }) {
  const meta = message.metadata;
  if (message.withdrawn_at || !meta?.source_message_id) return null;
  const references = Array.isArray(meta.knowledge)
    ? meta.knowledge.filter(
        (k): k is { id: string; title?: string; version?: number } =>
          typeof k === 'object' && k !== null && typeof k.id === 'string',
      )
    : [];
  const used = Array.isArray(meta.knowledge_used) ? meta.knowledge_used : [];
  const handover = Boolean(meta.handover);
  const examples = Array.isArray(meta.response_examples) ? meta.response_examples : [];
  const direct = meta.model === 'approved-knowledge' && !handover;
  return (
    <details className="ai-reply-details">
      <summary>
        <BookOpen size={13} />
        {handover
          ? 'เหตุผลที่ส่งต่อ'
          : direct
            ? 'ตอบจากฐานความรู้โดยตรง'
            : used.length
              ? 'AI ใช้ฐานความรู้'
              : 'รายละเอียดการตอบ'}
      </summary>
      {handover && <p>{reasons[String(meta.handover_reason)] || 'ส่งให้เจ้าหน้าที่ดูแล'}</p>}
      {direct && <p>ใช้ข้อความฉบับเผยแพร่ ยังไม่ได้ปรับสำนวนด้วยโมเดล</p>}
      {meta.model === 'service-dialogue' && <p>คำตอบสนทนาเบื้องต้นของระบบ</p>}
      {examples.length > 0 && (
        <p>
          <a href="/admin/training">ตัวอย่างวิธีตอบที่ส่งให้ Gemini {examples.length} รายการ</a>
        </p>
      )}
      {meta.response_kind === 'clarify' && (
        <p>กำลังเก็บรายละเอียดที่จำเป็นก่อนตอบหรือประสานเจ้าหน้าที่</p>
      )}
      {typeof meta.model === 'string' &&
        !['approved-knowledge', 'service-dialogue'].includes(meta.model) && (
          <p>โมเดล: {meta.model}</p>
        )}
      {typeof meta.provider_error === 'string' && (
        <p className="ai-reply-error">{meta.provider_error}</p>
      )}
      {references.length ? (
        <>
          <p>ความรู้ที่ค้นพบ {references.length} รายการ</p>
          <ul>
            {references.map((k) => (
              <li key={k.id}>
                <a href={`/admin/knowledge?id=${encodeURIComponent(k.id)}`}>
                  {k.title || 'เปิดความรู้'}
                  {k.version ? ` · v${k.version}` : ''}
                </a>
                {used.includes(k.id) ? ' · ใช้ตอบ' : ''}
              </li>
            ))}
          </ul>
        </>
      ) : (
        meta.model !== 'service-dialogue' && <p>ไม่พบความรู้ที่ตรงในฉบับเผยแพร่</p>
      )}
    </details>
  );
}
