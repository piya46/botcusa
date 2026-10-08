import { z } from 'zod';
import { defaultAiBehavior, type AiBehavior } from '../shared/ai.js';
import type { Queryable } from './db.js';
export const aiBehaviorSchema = z
  .object({
    mode: z.enum(['conversational', 'knowledge_only']),
    tone: z.enum(['friendly', 'formal']),
    language: z.enum(['auto', 'th', 'en']),
    length: z.enum(['short', 'balanced', 'detailed']),
    format: z.enum(['natural', 'bullets', 'steps']),
    clarificationLimit: z.number().int().min(1).max(3),
  })
  .strict();
export async function loadAiBehavior(db: Queryable): Promise<AiBehavior> {
  const [row] = await db.query("SELECT value FROM settings WHERE key='ai_behavior'");
  const result = aiBehaviorSchema.safeParse(row?.value);
  return result.success ? result.data : { ...defaultAiBehavior };
}
export function behaviorInstruction(b: AiBehavior) {
  return [
    b.tone === 'formal' ? 'ใช้ภาษาสุภาพ เป็นทางการ ไม่ใช้อีโมจิ' : 'สุภาพ เป็นกันเอง ไม่เยิ่นเย้อ',
    b.language === 'th'
      ? 'ตอบภาษาไทย'
      : b.language === 'en'
        ? 'ตอบภาษาอังกฤษ'
        : 'ตอบภาษาที่ผู้ใช้ใช้ ไทยเป็นค่าเริ่มต้น',
    {
      short: 'ตอบสั้น 1–3 ประโยค',
      balanced: 'ตอบพอดี เน้นรายละเอียดสำคัญ',
      detailed: 'อธิบายละเอียดเท่าที่จำเป็น',
    }[b.length],
    {
      natural: 'เขียนเป็นข้อความสนทนา',
      bullets: 'แบ่งหัวข้อสั้น ๆ เมื่อมีหลายประเด็น',
      steps: 'เรียงขั้นตอนเมื่ออธิบายวิธีทำ',
    }[b.format],
  ].join('\n');
}
export function basicReply(question: string, b: AiBehavior) {
  const q = question.trim().replace(/[!！.。?？\s\p{Extended_Pictographic}\uFE0F]+$/u, '');
  const english = b.language === 'en' || (b.language === 'auto' && /^[\x00-\x7f]+$/.test(q));
  const formal = b.tone === 'formal';
  if (
    /^(?:สวัสดี|หวัดดี|ดีจ้า|hello|hi|hey)(?:\s*(?:ครับผม|ครับ|ค่ะ|คะ|จ้า|จ้ะ|ค่า|คับ))?(?:\s*(?:มีเรื่องสอบถาม|มีเรื่องจะถาม|ขอสอบถาม|ขอถาม|สอบถามหน่อย)(?:ครับ|ค่ะ|คะ|ครับผม)?)?$/iu.test(
      q,
    )
  )
    return english
      ? 'Hello! I’m the CUSA AI assistant. How can I help you?'
      : formal
        ? 'สวัสดีค่ะ ดิฉันเป็นผู้ช่วย AI ของ CUSA กรุณาแจ้งเรื่องที่ต้องการสอบถามได้เลยค่ะ'
        : 'สวัสดีค่ะ ผู้ช่วย AI ของ CUSA ยินดีช่วยนะคะ วันนี้อยากสอบถามเรื่องอะไรคะ';
  if (/^(?:ขอบคุณ|ขอบใจ|thanks|thank you)(?:\s*(?:มาก|ครับ|ค่ะ|คะ|นะ|จ้า|ค่า))*$/iu.test(q))
    return english
      ? 'You’re welcome. Let me know if you need more help.'
      : 'ยินดีค่ะ หากมีเรื่องอื่นให้ช่วย แจ้งได้เลยนะคะ';
  if (
    /^(?:ช่วยอะไรได้บ้าง|ทำอะไรได้บ้าง|คุณคือใคร|เป็นบอทไหม|help|what can you do|who are you)$/iu.test(
      q,
    )
  )
    return english
      ? 'I’m CUSA’s AI assistant. I can explain published service information, help clarify a problem, and connect you with staff.'
      : 'ฉันเป็นผู้ช่วย AI ของ CUSA ช่วยตอบข้อมูลบริการที่มีในระบบ สอบถามรายละเอียดปัญหา และส่งต่อเจ้าหน้าที่ได้ค่ะ';
  return null;
}
export const conversationDecision = z
  .object({
    action: z.enum(['answer', 'clarify', 'handover']),
    kind: z.enum(['general', 'knowledge']),
    text: z.string().trim().max(4000),
    reference_ids: z.array(z.string().uuid()).max(3),
  })
  .strict();
