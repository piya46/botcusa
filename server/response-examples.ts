import { createHash } from 'node:crypto';
import type { Queryable, Row } from './db.js';
import { AppError } from './security.js';

const fingerprint = (row: Row) =>
  createHash('sha256')
    .update(JSON.stringify([row.question, row.answer, row.reviewed_at]))
    .digest('hex');

export async function responseExamplesEnabled(db: Queryable) {
  const [policy] = await db.query("SELECT value FROM settings WHERE key='training_policy'");
  return Boolean(policy?.value?.enabled && policy.value.notice_version?.trim());
}

async function sourceAvailable(db: Queryable, row: Row) {
  const ids = row.source_message_ids as string[];
  if (!Array.isArray(ids) || !ids.length) return false;
  const sources = await db.query(
    'SELECT id,withdrawn_at,internal,delivery_status FROM messages WHERE conversation_id=$2 AND id IN (SELECT jsonb_array_elements_text($1)::uuid)',
    [JSON.stringify(ids), row.conversation_id],
  );
  return (
    sources.length === new Set(ids).size &&
    sources.every(
      (m) =>
        !m.withdrawn_at &&
        !m.internal &&
        ['RECEIVED', 'ACCEPTED', 'SIMULATED'].includes(m.delivery_status),
    )
  );
}

export type ResponseExample = { id: string; question: string; answer: string; fingerprint: string };

// Curated examples guide the response, never become a replacement for current published facts.
export async function findResponseExamples(
  db: Queryable,
  question: string,
): Promise<ResponseExample[]> {
  if (!(await responseExamplesEnabled(db))) return [];
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('th').trim();
  const query = normalize(question);
  const ignored = new Set([
    'ครับ',
    'ค่ะ',
    'คะ',
    'นะ',
    'หน่อย',
    'อะไร',
    'ของ',
    'คือ',
    'the',
    'what',
    'please',
  ]);
  const words = [
    ...new Set(
      Array.from(new Intl.Segmenter('th', { granularity: 'word' }).segment(query))
        .filter((s) => s.isWordLike && s.segment.length > 1 && !ignored.has(s.segment))
        .map((s) => s.segment),
    ),
  ];
  const rows = await db.query(
    "SELECT t.* FROM training_examples t JOIN conversations c ON c.id=t.conversation_id WHERE t.status='APPROVED' AND t.reviewed_by<>t.created_by AND t.reviewed_at IS NOT NULL AND c.status='CLOSED' AND c.resolution IN ('RESOLVED_HUMAN','RESOLVED_BOT') ORDER BY t.reviewed_at DESC",
  );
  const ranked = rows
    .map((row) => ({
      row,
      score:
        (query && normalize(row.question) === query ? 10 : 0) +
        words.filter((w) => normalize(row.question).includes(w)).length,
    }))
    .filter((r) => r.score >= 2)
    .sort((a, b) => b.score - a.score);
  const result: ResponseExample[] = [];
  for (const { row } of ranked) {
    if (!(await sourceAvailable(db, row))) continue;
    result.push({
      id: row.id,
      question: row.question.slice(0, 1000),
      answer: row.answer.slice(0, 2000),
      fingerprint: fingerprint(row),
    });
    if (result.length === 3) break;
  }
  return result;
}

// A withdrawal during a provider request must not publish a reply using the withdrawn example.
// Throwing leaves the source unanswered so the durable job can retry with fresh evidence.
export async function assertResponseExamplesCurrent(db: Queryable, examples: ResponseExample[]) {
  if (!examples.length) return;
  const [behavior] = await db.query("SELECT value FROM settings WHERE key='ai_behavior'");
  if (!(await responseExamplesEnabled(db)) || behavior?.value?.useApprovedExamples === false)
    throw new AppError(409, 'การใช้ตัวอย่างเปลี่ยนแล้ว ต้องสร้างคำตอบใหม่');
  for (const example of examples) {
    const [row] = await db.query('SELECT * FROM training_examples WHERE id=$1 FOR SHARE', [
      example.id,
    ]);
    if (
      !row ||
      row.status !== 'APPROVED' ||
      fingerprint(row) !== example.fingerprint ||
      !(await sourceAvailable(db, row))
    )
      throw new AppError(409, 'ตัวอย่างถูกถอนหรือแก้ไข ต้องสร้างคำตอบใหม่');
  }
}
