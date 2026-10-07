import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CUSA_CALLBACK_PATH } from '../shared/sso.js';
import type { Config } from './config.js';
import type { Database, Row } from './db.js';
import { tokenHash } from './security.js';

export type SsoCallbackHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  transaction: Row,
  code: string,
) => Promise<unknown>;

const flows = {
  staff: {
    table: 'staff_sso_transactions',
    cookie: 'cusa_staff_login',
    invalid: '/admin?auth=invalid',
  },
  member: {
    table: 'sso_transactions',
    cookie: 'cusa_link',
    invalid: '/connect?result=invalid',
  },
} as const;
type Flow = keyof typeof flows;
const callbackSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  code: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  error: z.string().optional(),
});

export function registerSsoCallback(
  app: FastifyInstance,
  db: Database,
  config: Config,
  handlers: Record<Flow, SsoCallbackHandler>,
) {
  app.get(CUSA_CALLBACK_PATH, async (request, reply) => {
    // Cookies only choose the error page when state is unknown; they never choose a login flow.
    const fallback =
      request.cookies.cusa_staff_login && !request.cookies.cusa_link
        ? flows.staff.invalid
        : flows.member.invalid;
    const input = callbackSchema.safeParse(request.query);
    if (!input.success || config.demo) return reply.redirect(fallback);
    const hash = tokenHash(input.data.state);
    const result = await db.transaction(async (tx) => {
      const staff = await tx.query(
        'SELECT state_hash FROM staff_sso_transactions WHERE state_hash=$1',
        [hash],
      );
      const member = await tx.query('SELECT state_hash FROM sso_transactions WHERE state_hash=$1', [
        hash,
      ]);
      // Reject ambiguous/unknown state. The stored transaction is the only source of flow identity.
      if (staff.length + member.length !== 1) return null;
      const flow: Flow = staff.length ? 'staff' : 'member';
      const browser = request.cookies[flows[flow].cookie];
      if (!browser) return { flow, transaction: undefined };
      // Table names come exclusively from the constants above. Consumption is atomic across processes.
      const [transaction] = await tx.query(
        `DELETE FROM ${flows[flow].table} WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *`,
        [hash, tokenHash(browser)],
      );
      return { flow, transaction };
    });
    if (!result) return reply.redirect(fallback);
    const { flow, transaction } = result;
    if (!transaction) return reply.redirect(flows[flow].invalid);
    reply.clearCookie(flows[flow].cookie, {
      path: CUSA_CALLBACK_PATH,
      secure: true,
      sameSite: 'lax',
    });
    if (input.data.error !== undefined || !input.data.code)
      return reply.redirect(flows[flow].invalid);
    return handlers[flow](request, reply, transaction, input.data.code);
  });
}
