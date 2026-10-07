import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { openDatabase as openAppDatabase } from '../server/db.js';
import { mysqlConnectionOptions } from '../server/mysql.js';
export { enqueue, audit, type Database, type Queryable } from '../server/db.js';

// Each fixture owns a fresh database. Never reset a database supplied by the developer.
export async function openDatabase(options: Parameters<typeof openAppDatabase>[0]) {
  if (!process.env.TEST_MYSQL_URL || !options.memory) return openAppDatabase(options);
  const url = new URL(process.env.TEST_MYSQL_URL);
  if (!url.pathname.endsWith('_test'))
    throw new Error('TEST_MYSQL_URL must name a disposable *_test database');
  const name = 'cusa_test_' + randomUUID().replaceAll('-', '');
  const owner = await mysql.createConnection(mysqlConnectionOptions(url.href));
  await owner.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  url.pathname = '/' + name;
  const cleanup = async () => {
    try {
      await owner.query(`DROP DATABASE \`${name}\``);
    } finally {
      await owner.end();
    }
  };
  try {
    const db = await openAppDatabase({ ...options, databaseUrl: url.href });
    return {
      ...db,
      close: async () => {
        try {
          await db.close();
        } finally {
          await cleanup();
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
