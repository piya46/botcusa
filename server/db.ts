import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import pg from 'pg';
import { resolve } from 'node:path';
import { schema } from './schema.js';

export type Row = Record<string, any>;
export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(options: {
  databaseUrl?: string;
  dataDir?: string;
  memory?: boolean;
}): Promise<Database> {
  let db: Database;
  if (options.databaseUrl) {
    const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
    db = {
      async query<T extends Row>(sql: string, params?: unknown[]) {
        return (await pool.query<T>(sql, params)).rows;
      },
      async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({
            async query<R extends Row>(sql: string, params?: unknown[]) {
              return (await client.query<R>(sql, params)).rows;
            },
          });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      async close() {
        await pool.end();
      },
    };
    await pool.query(schema);
  } else {
    const lite = await PGlite.create({
      dataDir: options.memory ? 'memory://' : resolve(options.dataDir ?? '.data', 'postgres'),
      extensions: { vector },
    });
    await lite.exec(schema);
    db = {
      async query<T extends Row>(sql: string, params?: unknown[]) {
        return (await lite.query<T>(sql, params)).rows;
      },
      async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
        return lite.transaction(async (tx) =>
          fn({
            async query<R extends Row>(sql: string, params?: unknown[]) {
              return (await tx.query<R>(sql, params)).rows;
            },
          }),
        );
      },
      async close() {
        await lite.close();
      },
    };
  }
  return db;
}
export async function audit(
  db: Queryable,
  agentId: string | null,
  action: string,
  entityType: string,
  entityId?: string,
  details = {},
) {
  await db.query(
    'INSERT INTO audit_logs(agent_id, action, entity_type, entity_id, details) VALUES($1,$2,$3,$4,$5)',
    [agentId, action, entityType, entityId ?? null, JSON.stringify(details)],
  );
}
export async function enqueue(
  db: Queryable,
  kind: string,
  payload: unknown,
  dedupeKey: string,
  runAt?: Date,
) {
  await db.query(
    `INSERT INTO jobs(kind,payload,dedupe_key,run_at) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING`,
    [kind, JSON.stringify(payload), dedupeKey, runAt ?? new Date()],
  );
}
