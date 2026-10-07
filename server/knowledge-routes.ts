import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Agent } from '../shared/types.js';
import type { Config } from './config.js';
import { audit, type Database } from './db.js';
import { AppError } from './security.js';
import { readFileContent } from './media.js';
import { DOCUMENT_LIMIT, uploadDocument } from './documents.js';
import { analyticsAvailable, draftFromGap, queueAnalysis } from './insights.js';

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
  actor: (r: FastifyRequest) => Agent,
  reviewer: (r: FastifyRequest) => Agent,
) {
  const idOf = (r: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(r.params).id;
  app.get('/api/knowledge/documents', async () =>
    db.query(
      `SELECT d.*,(SELECT count(*)::int FROM knowledge WHERE document_id=d.id) AS chunks,(SELECT count(*)::int FROM knowledge WHERE document_id=d.id AND status='PUBLISHED') AS published FROM knowledge_documents d ORDER BY d.created_at DESC LIMIT 100`,
    ),
  );
  app.post('/api/knowledge/documents', { bodyLimit: DOCUMENT_LIMIT + 65536 }, async (request) => {
    const a = actor(request);
    const file = await request.file({
      limits: { fileSize: DOCUMENT_LIMIT, files: 1, fields: 2, fieldSize: 1000 },
    });
    if (!file) throw new AppError(400, 'กรุณาเลือกไฟล์');
    const bytes = await file.toBuffer();
    const value = (name: string) => {
      const f = file.fields[name];
      return f && !Array.isArray(f) && f.type === 'field' ? f.value : undefined;
    };
    const input = z
      .object({
        title: z.string().trim().min(3).max(160),
        category: z.string().trim().min(1).max(100),
      })
      .parse({ title: value('title'), category: value('category') });
    return uploadDocument(db, config, a.id, { ...input, filename: file.filename, bytes });
  });
  app.get('/api/knowledge/documents/:id/source', async (request, reply) => {
    const a = actor(request),
      id = idOf(request);
    const [doc] = await db.query(`SELECT * FROM knowledge_documents WHERE id=$1`, [id]);
    if (!doc) throw new AppError(404, 'ไม่พบเอกสาร');
    const bytes = await readFileContent(config, id);
    await audit(db, a.id, 'DOCUMENT_DOWNLOADED', 'knowledge_document', id);
    return reply
      .type(doc.mime_type)
      .header(
        'Content-Disposition',
        `attachment; filename="document.${doc.mime_type === 'application/pdf' ? 'pdf' : 'txt'}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      )
      .send(bytes);
  });
  app.post('/api/knowledge/documents/:id/archive', async (request) => {
    const a = reviewer(request),
      id = idOf(request);
    return db.transaction(async (tx) => {
      const [doc] = await tx.query(
        `UPDATE knowledge_documents SET status='ARCHIVED' WHERE id=$1 RETURNING id`,
        [id],
      );
      if (!doc) throw new AppError(404, 'ไม่พบเอกสาร');
      await tx.query(
        `UPDATE knowledge SET status='ARCHIVED',embedding=NULL,embedding_model=NULL,updated_at=now() WHERE document_id=$1`,
        [id],
      );
      await audit(tx, a.id, 'DOCUMENT_ARCHIVED', 'knowledge_document', id);
      return { ok: true };
    });
  });
  app.post('/api/knowledge/:id/archive', async (request) => {
    const a = reviewer(request),
      id = idOf(request);
    const [k] = await db.query(
      `UPDATE knowledge SET status='ARCHIVED',embedding=NULL,embedding_model=NULL,updated_at=now() WHERE id=$1 RETURNING id`,
      [id],
    );
    if (!k) throw new AppError(404, 'ไม่พบความรู้');
    await audit(db, a.id, 'KNOWLEDGE_ARCHIVED', 'knowledge', id);
    return { ok: true };
  });
  app.get('/api/insights', async () => {
    const gaps = await db.query(
      `SELECT g.*,c.number AS case_number FROM knowledge_gaps g JOIN conversations c ON c.id=g.conversation_id WHERE g.status<>'REVOKED' ORDER BY g.created_at DESC LIMIT 200`,
    );
    const analyses =
      await db.query(`SELECT c.id AS conversation_id,c.number AS case_number,c.status AS case_status,c.resolution,
      a.status,a.result,a.model,a.coverage,a.error,a.analyzed_at FROM conversations c
      LEFT JOIN conversation_analyses a ON a.conversation_id=c.id AND a.revision=c.analysis_revision
      WHERE c.status='CLOSED' OR a.conversation_id IS NOT NULL ORDER BY c.updated_at DESC LIMIT 100`);
    return { enabled: analyticsAvailable(config), gaps, analyses };
  });
  app.post('/api/insights/gaps/:id/draft', async (request) => {
    const input = z
      .object({
        title: z.string().trim().min(3).max(200),
        content: z.string().trim().min(10).max(12000),
        category: z.string().trim().min(1).max(100),
        keywords: z.array(z.string().trim().min(1).max(60)).max(30),
      })
      .parse(request.body);
    return draftFromGap(db, idOf(request), actor(request).id, input);
  });
  app.post('/api/insights/gaps/:id/dismiss', async (request) => {
    const a = reviewer(request),
      id = idOf(request);
    const [gap] = await db.query(
      `UPDATE knowledge_gaps SET status='DISMISSED' WHERE id=$1 AND status='OPEN' RETURNING id`,
      [id],
    );
    if (!gap) throw new AppError(409, 'รายการนี้ไม่ได้รอเติมความรู้');
    await audit(db, a.id, 'GAP_DISMISSED', 'knowledge_gap', id);
    return { ok: true };
  });
  app.post('/api/insights/conversations/:id/analyze', async (request) =>
    queueAnalysis(db, config, idOf(request), true, reviewer(request).id),
  );
}
