import { Worker as Thread } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { audit, enqueue, type Database } from './db.js';
import { AppError } from './security.js';
import { deleteFile, readFileContent, storeFile } from './media.js';

export const DOCUMENT_LIMIT = 8 * 1024 * 1024;
type Page = { page: number; text: string };
export async function extractDocument(bytes: Buffer, mime: string): Promise<Page[]> {
  if (bytes.length > DOCUMENT_LIMIT) throw new AppError(400, 'ไฟล์ต้องไม่เกิน 8 MB');
  if (mime === 'text/plain') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new AppError(400, 'ไฟล์ TXT ต้องใช้ UTF-8');
    }
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text))
      throw new AppError(400, 'ไฟล์ TXT มีข้อมูลไบนารี');
    if (text.length > 200_000) throw new AppError(400, 'เนื้อหาต้องไม่เกิน 200,000 ตัวอักษร');
    return [{ page: 1, text }];
  }
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new AppError(400, 'ไฟล์ PDF ไม่ถูกต้อง');
  // Keep parsing off the API event loop, with sequential pages and bounded resources.
  return new Promise((resolve, reject) => {
    const thread = new Thread(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { getDocumentProxy } = await import(workerData.moduleUrl);
        const pdf = await getDocumentProxy(workerData.bytes, {
          isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, verbosity: 0
        });
        try {
          if (pdf.numPages > 60) throw new Error('LIMIT');
          const pages = []; let length = 0;
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\\n' : ' ') : '').join('');
            length += text.length;
            if (length > 200000) throw new Error('LIMIT');
            pages.push({ page: i, text }); page.cleanup();
          }
          parentPort.postMessage({ pages });
        } finally { await pdf.destroy(); }
      })().catch(error => parentPort.postMessage({ error: error.message === 'LIMIT' ? 'LIMIT' : 'INVALID' }));
    `,
      {
        eval: true,
        workerData: { bytes: new Uint8Array(bytes), moduleUrl: import.meta.resolve('unpdf') },
        resourceLimits: { maxOldGenerationSizeMb: 96 },
      },
    );
    const fail = () =>
      reject(new AppError(400, 'อ่าน PDF ไม่สำเร็จ: ตรวจสอบว่าไฟล์ไม่เสียหายหรือมีรหัสผ่าน'));
    const timer = setTimeout(() => {
      void thread.terminate();
      reject(new AppError(400, 'อ่าน PDF เกินเวลา กรุณาแบ่งไฟล์ให้เล็กลง'));
    }, 20_000);
    thread.once('message', (result) => {
      clearTimeout(timer);
      void thread.terminate();
      if (result.error === 'LIMIT')
        reject(new AppError(400, 'PDF ต้องไม่เกิน 60 หน้า และ 200,000 ตัวอักษร'));
      else if (result.error) fail();
      else resolve(result.pages);
    });
    thread.once('error', () => {
      clearTimeout(timer);
      fail();
    });
    thread.once('exit', () => {
      clearTimeout(timer);
      fail();
    });
  });
}
export function documentChunks(pages: Page[]) {
  const chunks: Page[] = [];
  for (const page of pages) {
    let rest = page.text.replace(/\r\n?/g, '\n').trim();
    while (rest) {
      let end = Math.min(3000, rest.length);
      if (end < rest.length) {
        const boundary = Math.max(rest.lastIndexOf('\n', end), rest.lastIndexOf(' ', end));
        if (boundary > 1500) end = boundary;
        if (/^[\uDC00-\uDFFF]$/.test(rest[end])) end--;
      }
      chunks.push({ page: page.page, text: rest.slice(0, end).trim() });
      rest = rest.slice(end).trim();
      if (chunks.length > 100) throw new AppError(400, 'เนื้อหามีมากกว่า 100 ส่วน กรุณาแบ่งไฟล์');
    }
  }
  if (!chunks.length)
    throw new AppError(400, 'ไม่พบข้อความในไฟล์ หากเป็น PDF สแกน กรุณาทำ OCR ก่อนอัปโหลด');
  return chunks;
}
export async function uploadDocument(
  db: Database,
  config: Config,
  agentId: string,
  input: { filename: string; title: string; category: string; bytes: Buffer },
) {
  const filename = input.filename
    .split(/[\\/]/)
    .pop()!
    .replace(/[\r\n\x00-\x1f]/g, '')
    .slice(0, 180);
  const mime = /\.pdf$/i.test(filename)
    ? 'application/pdf'
    : /\.txt$/i.test(filename)
      ? 'text/plain'
      : null;
  if (!mime) throw new AppError(400, 'รองรับไฟล์ PDF และ TXT เท่านั้น');
  if (!input.bytes.length || input.bytes.length > DOCUMENT_LIMIT)
    throw new AppError(400, 'ไฟล์ต้องมีข้อมูลและไม่เกิน 8 MB');
  if (mime === 'application/pdf' && input.bytes.subarray(0, 5).toString() !== '%PDF-')
    throw new AppError(400, 'ไฟล์ PDF ไม่ถูกต้อง');
  if (mime === 'text/plain') documentChunks(await extractDocument(input.bytes, mime));
  const id = randomUUID();
  await storeFile(config, id, input.bytes);
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO knowledge_documents(id,filename,mime_type,byte_size,sha256,title,category,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          filename,
          mime,
          input.bytes.length,
          createHash('sha256').update(input.bytes).digest('hex'),
          input.title,
          input.category,
          agentId,
        ],
      );
      await enqueue(tx, 'INGEST_DOCUMENT', { documentId: id }, `document:${id}`);
      await audit(tx, agentId, 'DOCUMENT_UPLOADED', 'knowledge_document', id);
    });
  } catch (e) {
    await deleteFile(config, id);
    throw e;
  }
  return { id };
}
export async function ingestDocument(db: Database, config: Config, id: string) {
  const [doc] = await db.query(
    `SELECT * FROM knowledge_documents WHERE id=$1 AND status='QUEUED'`,
    [id],
  );
  if (!doc) return;
  let pages: Page[], chunks: Page[];
  try {
    pages = await extractDocument(await readFileContent(config, id), doc.mime_type);
    chunks = documentChunks(pages);
  } catch (e) {
    await db.query(
      `UPDATE knowledge_documents SET status='FAILED',error=$2 WHERE id=$1 AND status='QUEUED'`,
      [id, e instanceof AppError ? e.message : 'อ่านเอกสารไม่สำเร็จ กรุณาอัปโหลดอีกครั้ง'],
    );
    return;
  }
  await db.transaction(async (tx) => {
    const [current] = await tx.query(
      `SELECT status FROM knowledge_documents WHERE id=$1 FOR UPDATE`,
      [id],
    );
    if (current?.status !== 'QUEUED') return;
    for (const [i, chunk] of chunks.entries()) {
      await tx.query(
        `INSERT INTO knowledge(title,content,category,created_by,updated_by,document_id,source_page,source_index) VALUES($1,$2,$3,$4,$4,$5,$6,$7) ON CONFLICT(document_id,source_index) DO NOTHING`,
        [
          `${doc.title} · ${i + 1}/${chunks.length}`.slice(0, 200),
          chunk.text,
          doc.category,
          doc.created_by,
          id,
          chunk.page,
          i,
        ],
      );
    }
    await tx.query(
      `UPDATE knowledge_documents SET status='READY',pages=$2,empty_pages=$3,error=NULL WHERE id=$1`,
      [id, pages.length, pages.filter((p) => !p.text.trim()).length],
    );
    await audit(tx, null, 'DOCUMENT_EXTRACTED', 'knowledge_document', id, {
      chunks: chunks.length,
    });
  });
}
