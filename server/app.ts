import Fastify, { LogController, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Agent } from '../shared/types.js';
import type { Config } from './config.js';
import { audit, enqueue, type Database } from './db.js';
import {
  AppError,
  decrypt,
  encrypt,
  hashPassword,
  newToken,
  redact,
  tokenHash,
  validLineSignature,
  verifyPassword,
} from './security.js';
import { DEMO_AGENTS } from './seed.js';
import {
  claimCase,
  closeCase,
  conversationSelect,
  getConversation,
  getMessages,
  sendAgentMessage,
} from './conversations.js';
import { createDataset, createExample, reviewExample, assertTrainingEnabled } from './training.js';
import { logoutStaff } from './staff-refresh.js';
import { registerStaffSso, authenticateStaff } from './staff-sso.js';
import { registerSso } from './sso.js';
import { registerSsoCallback } from './sso-callback.js';
import { CUSA_CALLBACK_PATH } from '../shared/sso.js';
import { imageType, readFileContent, storeFile, deleteFile, verifyMedia } from './media.js';
import { lineRequest, type Fetcher } from './providers.js';
import {
  audienceBody,
  audienceFilters,
  audienceCount,
  audienceOptions,
  audienceRecipients,
} from './audiences.js';
import { listRichMenus, queueRichMenu } from './rich-menus.js';
import { operationalStats } from './stats.js';
import { listTeams, saveTeam, transferCase, transferHistory } from './tickets.js';
import { registerKnowledgeRoutes } from './knowledge-routes.js';
import { configureAgentLine } from './line-notifications.js';
import { lineRecipientType } from '../shared/line.js';
import { aiBehaviorSchema, loadAiBehavior } from './ai-behavior.js';
import { vertexConfigured } from './vertex-auth.js';
import { queueLineProfile } from './line-profiles.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    agent?: Agent;
  }
}
const uuid = z.string().uuid();
const pathId = (r: FastifyRequest) => z.object({ id: uuid }).parse(r.params).id;
const actor = (r: FastifyRequest) => {
  if (!r.agent) throw new AppError(401, 'กรุณาเข้าสู่ระบบ');
  return r.agent;
};
const reviewer = (r: FastifyRequest) => {
  const a = actor(r);
  if (!['ADMIN', 'REVIEWER'].includes(a.role)) throw new AppError(403, 'ต้องมีสิทธิ์ผู้ตรวจทาน');
  return a;
};
const admin = (r: FastifyRequest) => {
  const a = actor(r);
  if (a.role !== 'ADMIN') throw new AppError(403, 'ต้องมีสิทธิ์ผู้ดูแลระบบ');
  return a;
};
const knowledgeBody = z.object({
  title: z.string().trim().min(3).max(200),
  content: z.string().trim().min(10).max(12000),
  category: z.string().trim().min(1).max(100),
  keywords: z.array(z.string().trim().min(1).max(60)).max(30),
});

export async function buildApp(
  db: Database,
  config: Config,
  options: { fetcher?: Fetcher; serveStatic?: boolean; logger?: boolean } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 1 } });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(new AppError(400, 'JSON ไม่ถูกต้อง'), undefined);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบช่องที่กรอก',
        issues: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    const err = error as Error & { statusCode?: number; code?: string };
    const status = err.statusCode ?? (err.code === '23505' ? 409 : 500);
    if (status >= 500) request.log.error({ errorType: err.name, code: err.code }, 'Request failed');
    reply.code(status).send({
      error:
        status >= 500
          ? 'ระบบไม่พร้อมใช้งาน กรุณาลองใหม่'
          : err.code === '23505'
            ? 'ข้อมูลซ้ำหรือมีผู้ดำเนินการไปแล้ว'
            : err.message,
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    const pathname = request.url.split('?')[0];
    if (
      ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method) &&
      pathname !== '/api/webhook'
    ) {
      const accepted = new Set([config.origin]);
      if (config.demo) {
        accepted.add('http://localhost:5180');
        accepted.add('http://127.0.0.1:5180');
        accepted.add(`http://localhost:${config.port}`);
        accepted.add(`http://127.0.0.1:${config.port}`);
      }
      if (!request.headers.origin || !accepted.has(request.headers.origin))
        throw new AppError(403, 'ที่มาของคำขอไม่ถูกต้อง');
    }
    const publicRoutes = [
      '/api/health',
      '/api/install/status',
      '/api/auth/login',
      '/api/auth/sso/start',
      '/api/auth/logout',
      '/api/auth/demo',
      CUSA_CALLBACK_PATH,
      '/api/connect/config',
      '/api/connect/start',
      '/api/webhook',
    ];
    if (
      !pathname.startsWith('/api/') ||
      publicRoutes.includes(pathname) ||
      pathname.startsWith('/api/media/')
    )
      return;
    const session = request.cookies.cusa_session;
    if (!session) throw new AppError(401, 'กรุณาเข้าสู่ระบบ');
    if (!config.demo) {
      request.agent = await authenticateStaff(
        db,
        config,
        tokenHash(session),
        options.fetcher ?? fetch,
      );
      return;
    }
    const [user] = await db.query<Agent>(
      `SELECT a.id,a.name,a.email,a.role FROM auth_sessions s JOIN agents a ON a.id=s.agent_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active=true`,
      [tokenHash(session)],
    );
    if (!user) throw new AppError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    request.agent = user;
  });
  const setSession = async (reply: any, agent: Agent) => {
    const token = newToken();
    await db.query(
      `INSERT INTO auth_sessions(token_hash,agent_id,expires_at) VALUES($1,$2,now()+interval '12 hours')`,
      [tokenHash(token), agent.id],
    );
    reply.setCookie('cusa_session', token, {
      path: '/',
      httpOnly: true,
      secure: !config.demo,
      sameSite: 'strict',
      maxAge: 43200,
    });
    await audit(db, agent.id, 'LOGIN', 'agent', agent.id);
    return { agent, demo: config.demo };
  };
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/install/status', async () => ({ installed: true, restartRequired: false }));
  app.get('/api/runtime', async () => ({ workerMode: config.workerMode }));
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.demo) throw new AppError(403, 'ใช้ CUSA SSO เพื่อเข้าสู่ระบบ');
      const body = z
        .object({ email: z.string().email().max(254), password: z.string().min(1).max(200) })
        .parse(request.body);
      const [user] = await db.query(
        `SELECT * FROM agents WHERE lower(email)=lower($1) AND active=true`,
        [body.email],
      );
      // Equalize password hashing work even if the account is absent.
      const digest = user?.password_hash ?? hashPassword('invalid-account');
      if (!verifyPassword(body.password, digest) || !user)
        throw new AppError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
      return setSession(reply, {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      });
    },
  );
  app.post('/api/auth/demo', async (request, reply) => {
    if (!config.demo) throw new AppError(404, 'ไม่พบเส้นทาง');
    const { agentId } = z.object({ agentId: uuid.optional() }).parse(request.body ?? {});
    const user = DEMO_AGENTS.find((a) => a.id === (agentId ?? DEMO_AGENTS[0].id));
    if (!user) throw new AppError(400, 'ไม่พบบัญชีทดลอง');
    if (request.cookies.cusa_session)
      await db.query(`DELETE FROM auth_sessions WHERE token_hash=$1`, [
        tokenHash(request.cookies.cusa_session),
      ]);
    return setSession(reply, user as Agent);
  });
  app.get('/api/auth/me', async (request) => ({
    agent: actor(request),
    demo: config.demo,
    agents: config.demo ? DEMO_AGENTS : undefined,
  }));
  app.post('/api/auth/logout', async (request, reply) => {
    const hash = tokenHash(request.cookies.cusa_session ?? '');
    let ssoRevoked = true;
    if (config.demo) await db.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hash]);
    else ssoRevoked = await logoutStaff(db, config, hash, options.fetcher ?? fetch);
    reply.clearCookie('cusa_session', { path: '/' });
    return { ok: true, ssoRevoked };
  });
  app.get('/api/conversations', async (request) => {
    const q = z
      .object({
        status: z
          .enum(['ALL', 'BOT', 'WAITING_FOR_AGENT', 'AGENT_IN_CHARGE', 'CLOSED'])
          .default('ALL'),
        search: z.string().max(200).default(''),
        mine: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);
    return db.query(
      `${conversationSelect} WHERE ($1='ALL' OR c.status=$1) AND ($2='' OR u.name ILIKE $3 OR c.subject ILIKE $3 OR c.number::text=$2) AND ($4::uuid IS NULL OR c.assigned_agent_id=$4) ORDER BY CASE c.status WHEN 'WAITING_FOR_AGENT' THEN 0 WHEN 'AGENT_IN_CHARGE' THEN 1 WHEN 'BOT' THEN 2 ELSE 3 END, c.updated_at DESC LIMIT 100`,
      [q.status, q.search, `%${q.search}%`, q.mine === 'true' ? actor(request).id : null],
    );
  });
  app.get('/api/conversations/:id', async (request) => {
    const conversation = await getConversation(db, pathId(request));
    await queueLineProfile(db, config, conversation.user_id);
    return {
      conversation,
      messages: await getMessages(db, config, pathId(request)),
      transfers: await transferHistory(db, config, pathId(request)),
    };
  });
  app.post('/api/conversations/:id/transfer', async (request) => {
    const input = z
      .object({
        teamId: uuid,
        agentId: uuid.nullable(),
        reason: z.string().trim().min(10).max(2000),
        expectedVersion: z.number().int().nonnegative(),
        requestId: uuid,
      })
      .parse(request.body);
    return transferCase(db, config, actor(request), pathId(request), input);
  });
  app.get('/api/tickets', async (request) => {
    const q = z
      .object({
        status: z
          .enum(['OPEN', 'ALL', 'WAITING_FOR_AGENT', 'AGENT_IN_CHARGE', 'CLOSED'])
          .default('OPEN'),
        teamId: uuid.optional(),
        mine: z.enum(['true', 'false']).default('false'),
        search: z.string().max(200).default(''),
      })
      .parse(request.query);
    return db.query(
      `${conversationSelect} WHERE c.status<>'BOT'
      AND ($1='ALL' OR ($1='OPEN' AND c.status<>'CLOSED') OR c.status=$1)
      AND ($2::uuid IS NULL OR c.team_id=$2)
      AND ($3::uuid IS NULL OR c.assigned_agent_id=$3 OR (c.assigned_agent_id IS NULL AND EXISTS(SELECT 1 FROM team_members tm WHERE tm.team_id=c.team_id AND tm.agent_id=$3)))
      AND ($4='' OR c.subject ILIKE $5 OR u.name ILIKE $5 OR c.number::text=$4)
      ORDER BY CASE c.priority WHEN 'HIGH' THEN 0 ELSE 1 END,c.handover_at NULLS LAST LIMIT 200`,
      [
        q.status,
        q.teamId ?? null,
        q.mine === 'true' ? actor(request).id : null,
        q.search,
        `%${q.search}%`,
      ],
    );
  });
  const teamBody = z.object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).default(''),
    memberIds: z.array(uuid).min(1).max(100),
    active: z.boolean().default(true),
  });
  app.get('/api/teams', async () => listTeams(db));
  app.post('/api/teams', async (request) =>
    saveTeam(db, admin(request), teamBody.parse(request.body)),
  );
  app.patch('/api/teams/:id', async (request) =>
    saveTeam(db, admin(request), teamBody.parse(request.body), pathId(request)),
  );
  app.get('/api/agents', async (request) => {
    admin(request);
    return db.query(
      `SELECT id,name,role,active,line_user_id,line_alerts_enabled,line_identity_source FROM agents ORDER BY name`,
    );
  });
  app.patch('/api/agents/:id/line-notifications', async (request) => {
    const a = admin(request);
    const b = z
      .object({
        userId: z
          .string()
          .trim()
          .regex(/^U[0-9a-f]{32}$/)
          .nullable(),
        enabled: z.boolean(),
      })
      .parse(request.body);
    return configureAgentLine(db, a, pathId(request), b);
  });
  app.get('/api/line-notifications', async (request) => {
    admin(request);
    return db.query(
      `SELECT n.id,n.title,n.conversation_id,n.line_status,n.line_error,n.line_sent_at,n.created_at,a.name AS agent_name FROM notifications n JOIN agents a ON a.id=n.agent_id ORDER BY n.created_at DESC LIMIT 50`,
    );
  });
  app.get('/api/line-alerts', async (request) => {
    admin(request);
    const recipient = (id: string) => ({
      id,
      type: lineRecipientType(id),
      configured: Boolean(id && config.lineToken),
    });
    return {
      demo: config.demo,
      tokenConfigured: Boolean(config.lineToken),
      agent: recipient(config.agentAlertId),
      supervisor: recipient(config.supervisorAlertId),
      chats: await db.query(
        'SELECT id,type,active,last_event_at FROM line_chats ORDER BY last_event_at DESC LIMIT 50',
      ),
      jobs: await db.query(`SELECT j.id,j.status,j.last_error,j.attempts,j.created_at,j.completed_at,c.id AS conversation_id,c.number,
        j.payload->>'supervisor' AS supervisor,
        EXISTS(SELECT 1 FROM audit_logs a WHERE a.entity_id=c.id::text AND a.action IN ('AGENT_ALERT_ACCEPTED','SUPERVISOR_ALERT_ACCEPTED') AND a.details->>'jobId'=j.id::text) AS accepted
        FROM jobs j LEFT JOIN conversations c ON c.id::text=j.payload->>'conversationId'
        WHERE j.kind='ALERT' ORDER BY j.created_at DESC LIMIT 20`),
    };
  });
  app.get('/api/notifications', async (request) => {
    const id = actor(request).id;
    const [count] = await db.query(
      `SELECT count(*)::int AS unread FROM notifications WHERE agent_id=$1 AND read_at IS NULL`,
      [id],
    );
    return {
      unread: count.unread,
      items: await db.query(
        `SELECT n.id,n.agent_id,n.conversation_id,n.transfer_id,n.title,n.read_at,n.created_at,n.line_status,n.line_sent_at,n.line_error,c.number,c.status,c.assigned_agent_id FROM notifications n JOIN conversations c ON c.id=n.conversation_id WHERE n.agent_id=$1 ORDER BY (n.read_at IS NULL) DESC,n.created_at DESC LIMIT 50`,
        [id],
      ),
    };
  });
  app.post('/api/notifications/:id/read', async (request) => {
    const [row] = await db.query(
      `UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND agent_id=$2 RETURNING id`,
      [pathId(request), actor(request).id],
    );
    if (!row) throw new AppError(404, 'ไม่พบการแจ้งเตือน');
    return { ok: true };
  });
  app.post('/api/conversations/:id/claim', async (request) =>
    claimCase(db, config, actor(request), pathId(request)),
  );
  app.post('/api/conversations/:id/close', async (request) => {
    const b = z
      .object({
        resolution: z.enum(['RESOLVED_HUMAN', 'UNRESOLVED', 'ABANDONED']),
        note: z.string().trim().min(5).max(2000),
      })
      .parse(request.body);
    return closeCase(db, config, actor(request), pathId(request), b.resolution, b.note);
  });
  app.post('/api/conversations/:id/messages', async (request) => {
    const b = z
      .object({
        text: z.string().trim().min(1).max(4500),
        internal: z.boolean().default(false),
        clientRequestId: uuid,
      })
      .parse(request.body);
    return sendAgentMessage(
      db,
      config,
      actor(request),
      pathId(request),
      b.text,
      b.internal,
      b.clientRequestId,
    );
  });
  app.post('/api/conversations/:id/image', async (request) => {
    const a = actor(request),
      id = pathId(request);
    if (a.role === 'REVIEWER') throw new AppError(403, 'บัญชีนี้ไม่สามารถส่งข้อความได้');
    const part = await request.file();
    if (!part) throw new AppError(400, 'กรุณาเลือกภาพ');
    const bytes = await part.toBuffer(),
      mime = imageType(bytes);
    if (!mime) throw new AppError(400, 'รองรับภาพ PNG หรือ JPEG ขนาดไม่เกิน 1 MB');
    const attachmentId = randomUUID(),
      messageId = randomUUID();
    await storeFile(config, attachmentId, bytes);
    try {
      return await db.transaction(async (tx) => {
        const [c] = await tx.query(`SELECT * FROM conversations WHERE id=$1 FOR UPDATE`, [id]);
        if (
          !c ||
          c.status !== 'AGENT_IN_CHARGE' ||
          (c.assigned_agent_id !== a.id && a.role !== 'ADMIN')
        )
          throw new AppError(409, 'ต้องรับเคสก่อนส่งภาพ');
        await tx.query(
          `INSERT INTO messages(id,conversation_id,sender_type,agent_id,kind,encrypted_text,redacted_text,delivery_status,attachment_id) VALUES($1,$2,'AGENT',$3,'image',$4,'[รูปภาพ]','QUEUED',$5)`,
          [messageId, id, a.id, encrypt('[รูปภาพ]', config.encryptionKey), attachmentId],
        );
        await tx.query(
          `INSERT INTO attachments(id,message_id,filename,mime_type,byte_size,storage_path) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            attachmentId,
            messageId,
            'image.' + (mime === 'image/png' ? 'png' : 'jpg'),
            mime,
            bytes.length,
            attachmentId,
          ],
        );
        await enqueue(tx, 'DELIVERY', { messageId }, `delivery:${messageId}`);
        await tx.query(`UPDATE conversations SET updated_at=now() WHERE id=$1`, [id]);
        await audit(tx, a.id, 'IMAGE_QUEUED', 'message', messageId);
        return { id: messageId };
      });
    } catch (error) {
      await deleteFile(config, attachmentId);
      throw error;
    }
  });
  app.get('/api/attachments/:id', async (request, reply) => {
    const [file] = await db.query(
      `SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=$1 AND m.withdrawn_at IS NULL`,
      [pathId(request)],
    );
    if (!file) throw new AppError(404, 'ไม่พบไฟล์');
    await audit(db, actor(request).id, 'ATTACHMENT_VIEWED', 'attachment', file.id);
    reply
      .type(file.mime_type)
      .header(
        'Content-Disposition',
        `${['image/png', 'image/jpeg'].includes(file.mime_type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      );
    return reply.send(await readFileContent(config, file.storage_path));
  });
  app.get('/api/media/:id', async (request, reply) => {
    const id = pathId(request),
      q = z
        .object({ expires: z.coerce.number(), signature: z.string().max(64) })
        .parse(request.query);
    if (!verifyMedia(config, id, q.expires, q.signature)) throw new AppError(403, 'ลิงก์หมดอายุ');
    const [file] = await db.query(
      `SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=$1 AND m.withdrawn_at IS NULL AND m.sender_type='AGENT' AND a.mime_type IN ('image/png','image/jpeg')`,
      [id],
    );
    if (!file) throw new AppError(404, 'ไม่พบไฟล์');
    return reply.type(file.mime_type).send(await readFileContent(config, file.storage_path));
  });
  app.get('/api/conversations/:id/transcript', async (request, reply) => {
    const id = pathId(request),
      conversation = await getConversation(db, id),
      messages = await getMessages(db, config, id);
    await audit(db, actor(request).id, 'TRANSCRIPT_EXPORTED', 'conversation', id);
    reply.header('Content-Disposition', `attachment; filename="case-${conversation.number}.json"`);
    return {
      case_number: conversation.number,
      exported_at: new Date(),
      transfers: await transferHistory(db, config, id),
      messages: messages.map(
        ({
          id,
          sender_type,
          agent_name,
          text,
          content,
          kind,
          internal,
          delivery_status,
          created_at,
          withdrawn_at,
          attachment_id,
        }) => ({
          id,
          sender_type,
          agent_name,
          text,
          content,
          kind,
          internal,
          delivery_status,
          created_at,
          withdrawn_at,
          attachment_id,
        }),
      ),
    };
  });
  app.post('/api/conversations/:id/training', async (request) => {
    const b = z.object({ answerMessageId: uuid.optional() }).parse(request.body ?? {});
    return createExample(db, config, actor(request), pathId(request), b.answerMessageId);
  });
  app.get('/api/training', async () =>
    db.query(
      `SELECT t.*,c.number AS case_number,a.name AS created_by_name,r.name AS reviewed_by_name FROM training_examples t JOIN conversations c ON c.id=t.conversation_id JOIN agents a ON a.id=t.created_by LEFT JOIN agents r ON r.id=t.reviewed_by ORDER BY t.updated_at DESC LIMIT 200`,
    ),
  );
  app.patch('/api/training/:id', async (request) => {
    const a = actor(request),
      id = pathId(request),
      b = z
        .object({
          question: z.string().trim().min(3).max(6000),
          answer: z.string().trim().min(5).max(6000),
          notes: z.string().max(2000).default(''),
        })
        .parse(request.body);
    return db.transaction(async (tx) => {
      await assertTrainingEnabled(tx);
      const [original] = await tx.query(
        `SELECT t.*,(SELECT u.name FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=t.conversation_id) AS name,(SELECT u.email FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=t.conversation_id) AS email FROM training_examples t WHERE t.id=$1 FOR UPDATE`,
        [id],
      );
      if (!original || original.status !== 'DRAFT')
        throw new AppError(409, 'แก้ไขได้เฉพาะฉบับร่าง');
      const identifiers = [original.name, original.email].filter(Boolean);
      const context = original.context as { role: string; content: string }[];
      const lastQuestion = context.findLastIndex((m) => m.role === 'user');
      const cleanQuestion = redact(b.question, identifiers);
      if (lastQuestion >= 0) context[lastQuestion] = { role: 'user', content: cleanQuestion };
      else context.push({ role: 'user', content: cleanQuestion });
      const [ex] = await tx.query(
        `UPDATE training_examples SET question=$2,answer=$3,notes=$4,context=$6,created_by=$5,updated_at=now() WHERE id=$1 AND status='DRAFT' RETURNING *`,
        [
          id,
          cleanQuestion,
          redact(b.answer, identifiers),
          redact(b.notes, identifiers),
          a.id,
          JSON.stringify(context),
        ],
      );
      if (!ex) throw new AppError(409, 'แก้ไขได้เฉพาะฉบับร่าง');
      await audit(tx, a.id, 'TRAINING_EDITED', 'training_example', id);
      return ex;
    });
  });
  app.post('/api/training/:id/review', async (request) => {
    const a = reviewer(request),
      b = z
        .object({
          approve: z.boolean(),
          privacyReviewed: z.boolean().optional(),
          qualityReviewed: z.boolean().optional(),
        })
        .parse(request.body);
    if (b.approve && (!b.privacyReviewed || !b.qualityReviewed))
      throw new AppError(400, 'ยืนยันการตรวจข้อมูลส่วนบุคคลและความถูกต้องของคำตอบก่อนอนุมัติ');
    return reviewExample(db, a, pathId(request), b.approve);
  });
  app.get('/api/datasets', async () =>
    db.query(
      `SELECT d.*,(SELECT count(*)::int FROM dataset_items WHERE dataset_id=d.id) AS example_count,(SELECT count(*)::int FROM dataset_items WHERE dataset_id=d.id AND revoked_at IS NOT NULL) AS revoked_count FROM datasets d ORDER BY d.created_at DESC`,
    ),
  );
  app.post('/api/datasets', async (request) =>
    createDataset(
      db,
      reviewer(request),
      z.object({ name: z.string().trim().min(3).max(150) }).parse(request.body).name,
    ),
  );
  app.get('/api/datasets/:id/export', async (request, reply) => {
    const a = reviewer(request),
      id = pathId(request),
      q = z
        .object({ split: z.enum(['train', 'validation', 'test', 'all']).default('all') })
        .parse(request.query);
    const [dataset] = await db.query(`SELECT * FROM datasets WHERE id=$1`, [id]);
    if (!dataset) throw new AppError(404, 'ไม่พบชุดข้อมูล');
    const rows = await db.query(
      `SELECT i.snapshot,i.split FROM dataset_items i JOIN training_examples t ON t.id=i.example_id WHERE i.dataset_id=$1 AND i.revoked_at IS NULL AND t.status='APPROVED' AND ($2='all' OR i.split=$2) ORDER BY i.example_id`,
      [id, q.split],
    );
    await audit(db, a.id, 'DATASET_EXPORTED', 'dataset', id, {
      split: q.split,
      count: rows.length,
    });
    return reply
      .type('application/x-ndjson')
      .header(
        'Content-Disposition',
        `attachment; filename="cusa-dataset-v${dataset.version}-${q.split}.jsonl"`,
      )
      .send(
        rows.map((row) => JSON.stringify({ ...row.snapshot, split: row.split })).join('\n') +
          (rows.length ? '\n' : ''),
      );
  });
  registerKnowledgeRoutes(app, db, config, actor, reviewer);
  app.get('/api/knowledge', async () =>
    db.query(
      `SELECT id,title,content,category,keywords,status,version,created_by,updated_by,updated_at,published_content,document_id,source_page,source_index,source_message_id FROM knowledge ORDER BY updated_at DESC`,
    ),
  );
  app.post('/api/knowledge', async (request) => {
    const a = actor(request),
      b = knowledgeBody.parse(request.body);
    const [k] = await db.query(
      `INSERT INTO knowledge(title,content,category,keywords,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING id`,
      [b.title, b.content, b.category, JSON.stringify(b.keywords), a.id],
    );
    await audit(db, a.id, 'KNOWLEDGE_DRAFT_CREATED', 'knowledge', k.id);
    return k;
  });
  app.patch('/api/knowledge/:id', async (request) => {
    const a = actor(request),
      b = knowledgeBody.parse(request.body),
      id = pathId(request);
    const [k] = await db.query(
      `UPDATE knowledge SET title=$2,content=$3,category=$4,keywords=$5,status='DRAFT',updated_by=$6,updated_at=now() WHERE id=$1 AND status<>'ARCHIVED' RETURNING id`,
      [id, b.title, b.content, b.category, JSON.stringify(b.keywords), a.id],
    );
    if (!k) throw new AppError(404, 'ไม่พบข้อมูล');
    await audit(db, a.id, 'KNOWLEDGE_EDITED', 'knowledge', id);
    return k;
  });
  app.post('/api/knowledge/:id/publish', async (request) => {
    const a = reviewer(request),
      id = pathId(request);
    return db.transaction(async (tx) => {
      const [k] = await tx.query(`SELECT * FROM knowledge WHERE id=$1 FOR UPDATE`, [id]);
      if (!k || k.status !== 'DRAFT') throw new AppError(409, 'รายการนี้ไม่ได้เป็นฉบับร่าง');
      if (k.updated_by === a.id)
        throw new AppError(403, 'ให้ผู้ตรวจทานอีกคนอนุมัติเนื้อหาที่คุณแก้ไข');
      const version = k.published_content ? k.version + 1 : 1;
      await tx.query(
        `UPDATE knowledge SET status='PUBLISHED',published_content=content,published_title=title,published_keywords=keywords,version=$2,approved_by=$3,published_at=now(),embedding=NULL,embedding_model=NULL WHERE id=$1`,
        [id, version, a.id],
      );
      await tx.query(
        `INSERT INTO knowledge_versions(knowledge_id,version,title,content,keywords,approved_by) VALUES($1,$2,$3,$4,$5,$6)`,
        [id, version, k.title, k.content, JSON.stringify(k.keywords), a.id],
      );
      await enqueue(tx, 'EMBED', { knowledgeId: id, version }, `embed:${id}:${version}`);
      await audit(tx, a.id, 'KNOWLEDGE_PUBLISHED', 'knowledge', id, { version });
      return { ok: true };
    });
  });
  app.get('/api/members', async (request) => {
    const { search } = z.object({ search: z.string().max(200).default('') }).parse(request.query);
    return db.query(
      `SELECT u.id,u.name,u.email,u.department,u.cusa_sub,u.roles,u.avatar_color,u.blocked,u.created_at,u.linked_at,u.interest_tags,u.rich_menu_id,u.rich_menu_target,u.rich_menu_status,(SELECT count(*)::int FROM conversations WHERE user_id=u.id) AS conversations FROM users u WHERE $1='' OR u.name ILIKE $2 OR u.email ILIKE $2 ORDER BY u.updated_at DESC LIMIT 200`,
      [search, `%${search}%`],
    );
  });
  app.patch('/api/members/:id/interests', async (request) => {
    const a = admin(request),
      id = pathId(request);
    const { tags } = z.object({ tags: audienceFilters.shape.tags }).parse(request.body);
    return db.transaction(async (tx) => {
      const [user] = await tx.query(
        `UPDATE users SET interest_tags=$2,updated_at=now() WHERE id=$1 RETURNING id,interest_tags`,
        [id, JSON.stringify(tags)],
      );
      if (!user) throw new AppError(404, 'ไม่พบสมาชิก');
      await audit(tx, a.id, 'MEMBER_INTERESTS_UPDATED', 'user', id, { count: tags.length });
      return user;
    });
  });
  app.get('/api/rich-menus', async (request) => {
    admin(request);
    return listRichMenus(config, options.fetcher);
  });
  app.post('/api/members/:id/rich-menu', async (request) => {
    const a = admin(request),
      id = pathId(request);
    const { menuId } = z
      .object({
        menuId: z
          .string()
          .regex(/^richmenu-[0-9a-f]{32}$/)
          .nullable(),
      })
      .parse(request.body);
    if (
      menuId &&
      !(await listRichMenus(config, options.fetcher)).some(
        (m: { richMenuId: string }) => m.richMenuId === menuId,
      )
    )
      throw new AppError(400, 'ไม่พบ Rich Menu นี้ในบัญชี LINE ที่เชื่อมต่อ');
    return db.transaction(async (tx) => {
      const result = await queueRichMenu(tx, id, menuId);
      await audit(tx, a.id, 'RICH_MENU_REQUESTED', 'user', id, { menuId });
      return result;
    });
  });
  app.post('/api/members/:id/unlink', async (request) => {
    const a = admin(request),
      id = pathId(request);
    return db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET cusa_sub=NULL,email=NULL,department=NULL,roles='[]',linked_at=NULL,name=COALESCE(line_display_name,'ผู้ติดต่อ LINE'),updated_at=now() WHERE id=$1`,
        [id],
      );
      await queueRichMenu(tx, id, config.guestMenuId || null);
      await audit(tx, a.id, 'ACCOUNT_UNLINKED', 'user', id);
      return { ok: true };
    });
  });
  app.get('/api/stats', async () => {
    const [counts] = await db.query(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE status='WAITING_FOR_AGENT')::int AS waiting,count(*) FILTER(WHERE status='AGENT_IN_CHARGE')::int AS active,count(*) FILTER(WHERE status='CLOSED')::int AS closed,count(*) FILTER(WHERE status='BOT')::int AS bot FROM conversations`,
    );
    const [training] = await db.query(
      `SELECT count(*) FILTER(WHERE status='APPROVED')::int AS approved_examples,count(*) FILTER(WHERE status='DRAFT')::int AS draft_examples FROM training_examples`,
    );
    const [{ count }] = await db.query(
      `SELECT count(*)::int AS count FROM knowledge WHERE published_content IS NOT NULL AND status<>'ARCHIVED'`,
    );
    return {
      ...counts,
      ...training,
      operations: await operationalStats(db, config),
      published_knowledge: count,
      daily: await db.query(
        db.dialect === 'mysql'
          ? `WITH RECURSIVE days AS (SELECT DATE(DATE_ADD(now(),INTERVAL 7 HOUR))-INTERVAL 6 DAY AS day UNION ALL SELECT day+INTERVAL 1 DAY FROM days WHERE day<DATE(DATE_ADD(now(),INTERVAL 7 HOUR))) SELECT DATE_FORMAT(days.day,'%Y-%m-%d') AS day,COUNT(c.id) AS count,COUNT(CASE WHEN c.assigned_agent_id IS NOT NULL THEN c.id END) AS human FROM days LEFT JOIN conversations c ON DATE(DATE_ADD(c.created_at,INTERVAL 7 HOUR))=days.day GROUP BY days.day ORDER BY days.day`
          : `SELECT to_char(day,'YYYY-MM-DD') AS day,count(c.id)::int AS count,count(c.id) FILTER(WHERE c.assigned_agent_id IS NOT NULL)::int AS human FROM generate_series((now() AT TIME ZONE 'Asia/Bangkok')::date-6,(now() AT TIME ZONE 'Asia/Bangkok')::date,interval '1 day') day LEFT JOIN conversations c ON (c.created_at AT TIME ZONE 'Asia/Bangkok')::date=day::date GROUP BY day ORDER BY day`,
      ),
      categories: await db.query(
        `SELECT category,count(*)::int AS count FROM conversations GROUP BY category ORDER BY count DESC`,
      ),
      recent: await db.query(
        `${conversationSelect} WHERE c.status='WAITING_FOR_AGENT' ORDER BY c.handover_at LIMIT 5`,
      ),
    };
  });
  app.get('/api/broadcasts/audience-options', async (request) => {
    admin(request);
    return audienceOptions(db);
  });
  app.post('/api/broadcasts/preview', async (request) => {
    admin(request);
    const audience = audienceBody.parse(request.body);
    return { count: await audienceCount(db, audience) };
  });
  app.get('/api/broadcasts', async () =>
    db.query(
      `SELECT b.*,COALESCE((SELECT sum(jsonb_array_length(recipient_ids)) FROM broadcast_batches WHERE broadcast_id=b.id),0)::int AS recipient_count FROM broadcasts b ORDER BY created_at DESC LIMIT 100`,
    ),
  );
  app.post('/api/broadcasts', async (request) => {
    const a = admin(request),
      b = z
        .object({
          title: z.string().trim().min(3).max(150),
          content: z.string().trim().min(3).max(4500),
          segment: z.enum(['all', 'members', 'guests']),
          filters: audienceFilters.default({ departments: [], roles: [], tags: [] }),
        })
        .parse(request.body);
    const [row] = await db.query(
      `INSERT INTO broadcasts(title,content,segment,created_by,filters) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [b.title, b.content, b.segment, a.id, JSON.stringify(b.filters)],
    );
    await audit(db, a.id, 'BROADCAST_DRAFT_CREATED', 'broadcast', row.id);
    return row;
  });
  app.post('/api/broadcasts/:id/send', async (request) => {
    const a = admin(request),
      id = pathId(request),
      b = z.object({ scheduledAt: z.string().datetime().optional() }).parse(request.body ?? {});
    const when = b.scheduledAt ? new Date(b.scheduledAt) : new Date();
    if (b.scheduledAt && when.getTime() < Date.now())
      throw new AppError(400, 'เวลาส่งต้องอยู่ในอนาคต');
    if (!config.demo && !config.lineToken) throw new AppError(503, 'ยังไม่ได้ตั้งค่า LINE');
    return db.transaction(async (tx) => {
      const [campaign] = await tx.query(`SELECT * FROM broadcasts WHERE id=$1 FOR UPDATE`, [id]);
      if (!campaign || campaign.status !== 'DRAFT')
        throw new AppError(409, 'รายการนี้ถูกส่งหรือตั้งเวลาแล้ว');
      const recipients = await audienceRecipients(tx, audienceBody.parse(campaign));
      if (!recipients.length) throw new AppError(409, 'ไม่พบผู้รับในกลุ่มที่เลือก');
      if (!config.demo) {
        const [quota, usage] = await Promise.all([
          lineRequest(config, '/v2/bot/message/quota', undefined, undefined, options.fetcher),
          lineRequest(
            config,
            '/v2/bot/message/quota/consumption',
            undefined,
            undefined,
            options.fetcher,
          ),
        ]);
        if (quota.type === 'limited' && quota.value - usage.totalUsage < recipients.length)
          throw new AppError(409, 'โควตา LINE คงเหลือไม่เพียงพอสำหรับกลุ่มนี้');
      }
      for (let i = 0; i < recipients.length; i += 500) {
        const [batch] = await tx.query(
          `INSERT INTO broadcast_batches(broadcast_id,recipient_ids) VALUES($1,$2) RETURNING id`,
          [id, JSON.stringify(recipients.slice(i, i + 500).map((r) => r.line_user_id))],
        );
        await enqueue(tx, 'BROADCAST', { batchId: batch.id }, `broadcast:${batch.id}`, when);
      }
      await tx.query(`UPDATE broadcasts SET status=$2,scheduled_at=$3 WHERE id=$1`, [
        id,
        b.scheduledAt ? 'SCHEDULED' : 'SENDING',
        when,
      ]);
      await audit(tx, a.id, 'BROADCAST_SCHEDULED', 'broadcast', id, {
        recipients: recipients.length,
      });
      return { recipients: recipients.length };
    });
  });
  app.get('/api/settings', async (request) => {
    admin(request);
    const settings = await db.query(`SELECT key,value FROM settings`);
    const [{ count: failedJobs }] = await db.query(
      `SELECT count(*)::int AS count FROM jobs WHERE status='FAILED'`,
    );
    return {
      demo: config.demo,
      origin: config.origin,
      webhookUrl: `${config.origin}/api/webhook`,
      callbackUrl: config.origin + CUSA_CALLBACK_PATH,
      chatRetentionDays: config.chatRetentionDays,
      datasetRetentionDays: config.datasetRetentionDays,
      failedJobs,
      workerMode: config.workerMode,
      supervisorAlertsConfigured:
        config.demo || Boolean(config.supervisorAlertId && config.lineToken),
      agentAlertsConfigured: config.demo || Boolean(config.agentAlertId && config.lineToken),
      lineLoading: { enabled: config.lineLoadingEnabled, seconds: config.lineLoadingSeconds },
      integrations: {
        line: !config.demo && Boolean(config.lineToken && config.lineSecret),
        sso:
          !config.demo &&
          Boolean(
            config.ssoClientId && config.ssoApiKey && config.lineLoginChannelId && config.liffId,
          ),
        vertex: vertexConfigured(config),
        aiModel: config.vertexModel,
        database:
          db.dialect === 'mysql'
            ? 'MySQL / MariaDB'
            : config.databaseUrl
              ? 'PostgreSQL'
              : 'Embedded PostgreSQL',
      },
      settings: {
        ...Object.fromEntries(settings.map((s) => [s.key, s.value])),
        ai_behavior: await loadAiBehavior(db),
      },
    };
  });
  app.patch('/api/settings', async (request) => {
    const a = admin(request),
      b = z
        .object({
          system_prompt: z.string().trim().min(30).max(8000),
          ai_behavior: aiBehaviorSchema.optional(),
          training_policy: z.object({
            enabled: z.boolean(),
            notice_version: z.string().max(100),
            purpose: z.string().trim().min(10).max(500),
          }),
        })
        .parse(request.body);
    if (b.training_policy.enabled && !b.training_policy.notice_version.trim())
      throw new AppError(400, 'ระบุเวอร์ชันประกาศการใช้ข้อมูลก่อนเปิดใช้งาน');
    await db.transaction(async (tx) => {
      for (const [key, value] of Object.entries(b))
        await tx.query(
          `INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()`,
          [key, JSON.stringify(value)],
        );
      await audit(tx, a.id, 'SETTINGS_UPDATED', 'settings');
    });
    return { ok: true };
  });
  app.get('/api/audit', async (request) => {
    admin(request);
    return db.query(
      `SELECT l.*,a.name AS agent_name FROM audit_logs l LEFT JOIN agents a ON a.id=l.agent_id ORDER BY created_at DESC LIMIT 100`,
    );
  });
  app.post('/api/agents', async (request) => {
    if (!config.demo) throw new AppError(403, 'กำหนดบทบาทเจ้าหน้าที่ผ่าน CUSA SSO');
    const a = admin(request),
      b = z
        .object({
          name: z.string().trim().min(2).max(100),
          email: z.string().email(),
          password: z.string().min(12).max(200),
          role: z.enum(['AGENT', 'REVIEWER', 'ADMIN']),
        })
        .parse(request.body);
    const [user] = await db.query(
      `INSERT INTO agents(name,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,email,role`,
      [b.name, b.email.toLowerCase(), hashPassword(b.password), b.role],
    );
    await audit(db, a.id, 'AGENT_CREATED', 'agent', user.id);
    return user;
  });
  app.post('/api/webhook', { config: { rateLimit: false } }, async (request, reply) => {
    if (
      !validLineSignature(
        request.rawBody ?? Buffer.alloc(0),
        String(request.headers['x-line-signature'] ?? ''),
        config.lineSecret,
      )
    )
      throw new AppError(401, 'Invalid signature');
    const payload = z
      .object({
        events: z
          .array(z.object({ webhookEventId: z.string().max(100), type: z.string() }).passthrough())
          .max(100),
      })
      .parse(request.body);
    await db.transaction(async (tx) => {
      for (const event of payload.events) {
        const [saved] = await tx.query(
          `INSERT INTO webhook_events(id,encrypted_payload) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id`,
          [event.webhookEventId, encrypt(JSON.stringify(event), config.encryptionKey)],
        );
        if (saved) await enqueue(tx, 'WEBHOOK', { eventId: saved.id }, `webhook:${saved.id}`);
      }
    });
    return reply.code(200).send({ ok: true });
  });
  app.post('/api/demo/message', async (request) => {
    if (!config.demo) throw new AppError(404, 'ไม่พบเส้นทาง');
    const b = z
      .object({ conversationId: uuid.optional(), text: z.string().trim().min(1).max(4500) })
      .parse(request.body);
    let lineId = `demo-user-${randomUUID()}`;
    if (b.conversationId) {
      const [u] = await db.query(
        `SELECT u.line_user_id FROM conversations c JOIN users u ON u.id=c.user_id WHERE c.id=$1`,
        [b.conversationId],
      );
      if (!u) throw new AppError(404, 'ไม่พบเคส');
      lineId = u.line_user_id;
    }
    const id = randomUUID(),
      event = {
        type: 'message',
        webhookEventId: id,
        timestamp: Date.now(),
        source: { type: 'user', userId: lineId },
        message: { type: 'text', id: randomUUID(), text: b.text },
      };
    await db.transaction(async (tx) => {
      await tx.query(`INSERT INTO webhook_events(id,encrypted_payload) VALUES($1,$2)`, [
        id,
        encrypt(JSON.stringify(event), config.encryptionKey),
      ]);
      await enqueue(tx, 'WEBHOOK', { eventId: id }, `webhook:${id}`);
    });
    return { ok: true };
  });
  const memberCallback = registerSso(app, db, config, options.fetcher);
  const staffCallback = registerStaffSso(app, db, config, options.fetcher);
  registerSsoCallback(app, db, config, { member: memberCallback, staff: staffCallback });
  if (options.serveStatic && existsSync(resolve('dist'))) {
    await app.register(staticFiles, { root: resolve('dist'), prefix: '/' });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'ไม่พบ API' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
