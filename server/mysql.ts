import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database, Queryable, Row } from './db.js';
import { mysqlSchema, mysqlUuidTables, mysqlAddColumns } from './mysql-schema.js';

// This adapter implements the application's SQL subset, not arbitrary PostgreSQL SQL.
// Values always use prepared parameters. RETURNING and conflict handling run on one transaction.
function topLevel(sql: string, keyword: string) {
  let depth = 0,
    quote = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      if (c === quote && sql[i + 1] === quote) i++;
      else if (c === quote) quote = '';
      else if (c === '\\') i++;
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (
      !depth &&
      sql.slice(i, i + keyword.length).toUpperCase() === keyword.toUpperCase() &&
      (keyword === ',' ||
        (!/[\w]/.test(sql[i - 1] ?? '') && !/[\w]/.test(sql[i + keyword.length] ?? '')))
    )
      return i;
  }
  return -1;
}
function split(sql: string) {
  const parts: string[] = [];
  let rest = sql;
  for (let at; (at = topLevel(rest, ',')) !== -1;) {
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at + 1);
  }
  parts.push(rest.trim());
  return parts;
}
function closeParen(sql: string, start: number) {
  let depth = 0,
    quote = false;
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === "'") {
      if (quote && sql[i + 1] === "'") {
        i++;
        continue;
      }
      quote = !quote;
    }
    if (!quote) {
      if (sql[i] === '(') depth++;
      if (sql[i] === ')' && --depth === 0) return i;
    }
  }
  throw new Error('Unbalanced application SQL');
}

export function mysqlStatement(input: string, params: unknown[] = []) {
  let sql = input.trim();
  // Interval arithmetic, JSON collections and array parameters used by the repository.
  sql = sql.replace(
    /\(\s*(\$\d+)\s*\*\s*interval\s*'(\d+) (second|minute|hour|day)s?'\s*\)/gi,
    (_, p, n, unit) => `INTERVAL (${p} * ${n}) ${unit}`,
  );
  sql = sql.replace(/interval\s*'(\d+) (second|minute|hour|day)s?'/gi, 'INTERVAL $1 $2');
  sql = sql.replace(
    /SELECT jsonb_array_elements_text\((\$\d+)\)::uuid/gi,
    (_, p) =>
      `SELECT item FROM JSON_TABLE(${p}, '$[*]' COLUMNS(item VARCHAR(191) PATH '$')) AS ids`,
  );
  sql = sql.replace(/cardinality\((\$\d+)::text\[\]\)/gi, 'JSON_LENGTH($1)');
  sql = sql.replace(
    /([\w.]+)\s*=\s*ANY\((\$\d+)::(?:text|uuid)\[\]\)/gi,
    (_, column, p) =>
      `${column} IN (SELECT item FROM JSON_TABLE(${p}, '$[*]' COLUMNS(item VARCHAR(255) PATH '$')) AS choices)`,
  );
  sql = sql.replace(
    /([\w.]+)\s*\?\|\s*(\$\d+)::text\[\]/gi,
    (_, column, p) =>
      `EXISTS(SELECT 1 FROM JSON_TABLE(${p}, '$[*]' COLUMNS(item VARCHAR(255) PATH '$')) AS choices WHERE JSON_CONTAINS(${column},JSON_QUOTE(choices.item)))`,
  );
  sql = sql.replace(
    /([\w.]+)\s*->>\s*'([a-z_]+)'/gi,
    (_, column, key) => `JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.${key}'))`,
  );
  sql = sql.replace(/([\w.]+)\s*@>\s*(\$\d+)::jsonb/gi, 'JSON_CONTAINS($1,$2)');
  sql = sql.replace(/([\w.]+)\s*\?\s*(\$\d+)/g, 'JSON_CONTAINS($1,JSON_QUOTE($2))');
  sql = sql.replace(/jsonb_array_length\(/gi, 'JSON_LENGTH(');
  // FILTER conditions may contain nested expressions, so use balanced parentheses.
  const filter = /count\(([^()]*)\)\s*FILTER\s*\(WHERE\s*/i;
  for (let match; (match = filter.exec(sql));) {
    const open = sql.indexOf('(', match.index + match[0].toUpperCase().indexOf('FILTER'));
    const end = closeParen(sql, open);
    const condition = sql.slice(match.index + match[0].length, end);
    sql =
      sql.slice(0, match.index) +
      `COUNT(CASE WHEN ${condition} THEN ${match[1] === '*' ? '1' : match[1]} ELSE NULL END)` +
      sql.slice(end + 1);
  }
  sql = sql.replace(/([\w.]+)::text\b/gi, 'CAST($1 AS CHAR)');
  sql = sql.replace(/::(?:uuid|jsonb|vector|int|integer|numeric|boolean)\b/gi, '');
  sql = sql.replace(/\bILIKE\b/gi, 'LIKE').replace(/\bnow\(\)/gi, 'CURRENT_TIMESTAMP(3)');
  sql = sql.replace(/([\w.]+)\s+NULLS LAST/gi, '$1 IS NULL,$1');
  sql = sql.replace(
    /COLUMNS\(item VARCHAR\((\d+)\) PATH/gi,
    'COLUMNS(item VARCHAR($1) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci PATH',
  );
  sql = sql.replace(/FOR SHARE\s*$/i, 'LOCK IN SHARE MODE');
  // Quote reserved identifiers, never literals or parameter values.
  const literals: string[] = [];
  sql = sql.replace(/'(?:''|\\.|[^'\\])*'/g, (value) => `__literal_${literals.push(value) - 1}__`);
  sql = sql.replace(/(?<![`\w])(?:key|sequence)(?![`\w])/gi, (word) => `\`${word}\``);
  const values: any[] = [];
  sql = sql.replace(/\$(\d+)/g, (_, n) => {
    if (Number(n) > params.length) throw new Error('Missing SQL parameter');
    const value = params[Number(n) - 1];
    values.push(Array.isArray(value) ? JSON.stringify(value) : (value ?? null));
    return '?';
  });
  sql = sql.replace(/__literal_(\d+)__/g, (_, n) => literals[Number(n)]);
  if (
    /::|\bRETURNING\b|\bON CONFLICT\b|\bFOR (?:UPDATE|SHARE) OF\b|\bjsonb_|\bFILTER\s*\(|\bgenerate_series\b/i.test(
      sql,
    )
  )
    throw new Error('Unsupported SQL in MySQL adapter');
  return { sql, values };
}

const jsonColumns = new Set([
  'roles',
  'tags',
  'interest_tags',
  'metadata',
  'payload',
  'keywords',
  'published_keywords',
  'embedding',
  'source_message_ids',
  'context',
  'snapshot',
  'filters',
  'recipient_ids',
  'details',
  'value',
  'result',
  'coverage',
  'members',
]);
const booleanColumns = new Set([
  'active',
  'blocked',
  'internal',
  'reply_reserved',
  'line_alerts_enabled',
  'fresh',
]);
function normalize(
  rows: Row[],
  fields: { name: string; orgName?: string; table?: string; orgTable?: string }[],
) {
  for (const row of rows)
    for (const field of fields) {
      const key = field.name,
        value = row[key];
      if (value === null || value === undefined) continue;
      if (booleanColumns.has(key)) row[key] = Boolean(Number(value));
      // A string alias named "value" (audience choices) is not settings.value JSON.
      else if (
        jsonColumns.has(key) &&
        (key !== 'value' || field.orgTable === 'settings' || field.table === 'settings') &&
        typeof value === 'string'
      )
        row[key] = JSON.parse(value);
    }
  return rows;
}
const identifier = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('Invalid application SQL identifier');
  return `\`${name}\``;
};
function primaryKey(table: string) {
  return ['sso_transactions', 'staff_sso_transactions'].includes(table)
    ? 'state_hash'
    : table === 'settings'
      ? 'key'
      : 'id';
}

export function mysqlConnectionOptions(databaseUrl: string, caFile?: string) {
  const url = new URL(databaseUrl);
  if (!['mysql:', 'mariadb:'].includes(url.protocol) || !url.pathname.slice(1))
    throw new Error('MySQL URL requires a database name');
  if ([...url.searchParams.keys()].some((key) => key !== 'ssl'))
    throw new Error('MySQL URL supports only the ssl parameter; use ssl=true for verified TLS');
  const ssl = url.searchParams.get('ssl');
  if (
    url.searchParams.getAll('ssl').length > 1 ||
    (ssl !== null && !['true', 'verify-full'].includes(ssl))
  )
    throw new Error('MySQL TLS must verify the server certificate');
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    jsonStrings: true,
    connectTimeout: 10000,
    connectionLimit: 5,
    ...(ssl || caFile
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(caFile ? { ca: readFileSync(caFile, 'utf8') } : {}),
          },
        }
      : {}),
  };
}

export function assertMysqlVersion(version: string) {
  const maria = /mariadb/i.test(version);
  // Some MariaDB servers prepend the MySQL protocol compatibility version.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(
    maria ? version.replace(/^5\.5\.5-/, '') : version,
  );
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [0, 0, 0];
  if (
    maria
      ? major < 10 || (major === 10 && minor < 6)
      : major < 8 || (major === 8 && minor === 0 && patch < 17)
  )
    throw new Error('Requires MySQL 8.0.17+ or MariaDB 10.6+');
}

export async function openMysql(options: {
  databaseUrl: string;
  mysqlSslCa?: string;
  migrate?: boolean;
}): Promise<Database> {
  const pool = mysql.createPool(mysqlConnectionOptions(options.databaseUrl, options.mysqlSslCa));
  const raw = async (
    connection: PoolConnection,
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    const query = mysqlStatement(sql, params);
    const [result, fields] = await connection.execute<RowDataPacket[]>(query.sql, query.values);
    return Array.isArray(result) ? normalize(result, fields) : [];
  };
  const execute = async (
    connection: PoolConnection,
    input: string,
    initial: unknown[] = [],
  ): Promise<Row[]> => {
    const params = [...initial];
    let sql = input.trim(),
      returning = '';
    const at = topLevel(sql, 'RETURNING');
    if (at !== -1) {
      returning = sql.slice(at + 9).trim();
      sql = sql.slice(0, at).trim();
    }
    const insert = /^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*/i.exec(sql);
    if (insert) {
      const table = insert[1],
        columns = split(insert[2]);
      let tuples = sql.slice(insert[0].length),
        conflict = '';
      const conflictAt = topLevel(tuples, 'ON CONFLICT');
      if (conflictAt !== -1) {
        conflict = tuples.slice(conflictAt);
        tuples = tuples.slice(0, conflictAt).trim();
      }
      const rows: Row[] = [];
      for (const tuple of split(tuples)) {
        if (tuple[0] !== '(' || tuple.at(-1) !== ')')
          throw new Error('Unsupported application INSERT');
        const values = split(tuple.slice(1, -1)),
          names = [...columns];
        for (const name of [
          ...(mysqlUuidTables.has(table) ? ['id'] : []),
          ...(table === 'broadcast_batches' ? ['retry_key'] : []),
        ]) {
          if (!names.includes(name)) {
            names.push(name);
            params.push(randomUUID());
            values.push(`$${params.length}`);
          }
        }
        const expressions = new Map(names.map((name, i) => [name, values[i]]));
        let keys = [primaryKey(table)],
          where = keys.map((key) => `${identifier(key)}=${expressions.get(key)}`).join(' AND ');
        let changed = true;
        try {
          await raw(
            connection,
            `INSERT INTO ${identifier(table)}(${names.map(identifier).join(',')}) VALUES(${values.join(',')})`,
            params,
          );
        } catch (error) {
          if ((error as { code?: string }).code !== 'ER_DUP_ENTRY' || !conflict) throw error;
          const target =
            /^ON CONFLICT\s*(?:\(([^)]+)\))?\s*DO\s+(NOTHING|UPDATE SET ([\s\S]+))$/i.exec(
              conflict,
            );
          if (!target) throw new Error('Unsupported application conflict clause');
          if (target[1]) {
            keys = split(target[1]);
            if (keys.some((key) => !expressions.has(key)))
              throw new Error('Conflict key missing from INSERT');
            where = keys.map((key) => `${identifier(key)}=${expressions.get(key)}`).join(' AND ');
            if (
              !(
                await raw(
                  connection,
                  `SELECT 1 FROM ${identifier(table)} WHERE ${where} FOR UPDATE`,
                  params,
                )
              ).length
            )
              throw error;
          }
          if (target[2].toUpperCase() === 'NOTHING') changed = false;
          else {
            if (!target[1]) throw new Error('Conflict UPDATE requires keys');
            const assignments = target[3].replace(
              /excluded\.(\w+)/gi,
              (_, name) =>
                expressions.get(name) ??
                (() => {
                  throw new Error('Unknown conflict column');
                })(),
            );
            await execute(connection, `UPDATE ${table} SET ${assignments} WHERE ${where}`, params);
          }
        }
        if (changed && table === 'messages')
          await raw(
            connection,
            `UPDATE conversations SET analysis_revision=analysis_revision+1 WHERE id IN (SELECT conversation_id FROM messages WHERE ${where} AND NOT internal AND sender_type<>'SYSTEM')`,
            params,
          );
        if (returning && changed)
          rows.push(
            ...(await raw(
              connection,
              `SELECT ${returning} FROM ${identifier(table)} WHERE ${where}`,
              params,
            )),
          );
      }
      return rows;
    }
    const update = /^UPDATE (\w+) SET\s+/i.exec(sql),
      deletion = /^DELETE FROM (\w+)\s*/i.exec(sql);
    const table = update?.[1] ?? deletion?.[1];
    let selected: Row[] = [];
    const bumpMessages =
      table === 'messages' &&
      Boolean(update) &&
      /(?:^|,)\s*(?:encrypted_text|withdrawn_at|delivery_status)\s*=/i.test(
        sql.slice(update![0].length),
      );
    if (table && (returning || bumpMessages)) {
      const whereAt = topLevel(sql, 'WHERE'),
        clause = whereAt === -1 ? '' : sql.slice(whereAt);
      selected = await raw(connection, `SELECT * FROM ${table} ${clause} FOR UPDATE`, params);
      if (!selected.length) return [];
    }
    if (table === 'conversations' && update) {
      const whereAt = topLevel(sql, 'WHERE');
      const assignments = split(sql.slice(update[0].length, whereAt === -1 ? undefined : whereAt));
      const watched = assignments
        .map((s) => /^(status|resolution)\s*=\s*([\s\S]+)$/i.exec(s))
        .filter(Boolean) as RegExpExecArray[];
      if (watched.length)
        sql =
          sql.slice(0, update[0].length) +
          `analysis_revision=analysis_revision+IF(${watched.map((m) => `NOT (${m[1]} <=> ${m[2]})`).join(' OR ')},1,0),` +
          sql.slice(update[0].length);
    }
    await raw(connection, sql, params);
    if (bumpMessages) {
      const cases = new Map<string, number>();
      for (const row of selected)
        if (!row.internal && row.sender_type !== 'SYSTEM')
          cases.set(row.conversation_id, (cases.get(row.conversation_id) ?? 0) + 1);
      for (const [id, count] of cases)
        await raw(
          connection,
          'UPDATE conversations SET analysis_revision=analysis_revision+$2 WHERE id=$1',
          [id, count],
        );
    }
    if (returning && deletion) {
      if (returning !== '*') throw new Error('Unsupported DELETE projection');
      return selected;
    }
    if (returning && table) {
      const key = primaryKey(table),
        values = selected.map((row) => row[key]);
      return raw(
        connection,
        `SELECT ${returning} FROM ${table} WHERE ${identifier(key)} IN (${values.map((_, i) => `$${i + 1}`).join(',')})`,
        values,
      );
    }
    // SELECTs have no mutation/RETURNING path.
    return [];
  };
  const query = async (connection: PoolConnection, sql: string, params?: unknown[]) =>
    /^\s*(SELECT|WITH)\b/i.test(sql)
      ? raw(connection, sql, params)
      : execute(connection, sql, params);
  const transaction = async <T>(fn: (tx: Queryable) => Promise<T>) => {
    const connection = await pool.getConnection();
    try {
      await connection.query(
        "SET time_zone='+00:00', sql_mode=CONCAT_WS(',',@@sql_mode,'STRICT_ALL_TABLES','ONLY_FULL_GROUP_BY')",
      );
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction();
      const result = await fn({
        dialect: 'mysql',
        query: async <R extends Row>(sql: string, params?: unknown[]) =>
          (await query(connection, sql, params)) as R[],
      });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY')
        (error as { code: string }).code = '23505';
      throw error;
    } finally {
      connection.release();
    }
  };
  try {
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
      assertMysqlVersion(String(rows[0].version));
      if (options.migrate !== false) {
        const lockName =
          'cusa-schema-' +
          createHash('sha256')
            .update(new URL(options.databaseUrl).pathname)
            .digest('hex')
            .slice(0, 32);
        const [locks] = await connection.execute<RowDataPacket[]>(
          'SELECT GET_LOCK(?,30) AS acquired',
          [lockName],
        );
        if (Number(locks[0].acquired) !== 1) throw new Error('Database migration already running');
        try {
          for (const statement of mysqlSchema) await connection.query(statement);
          for (const [table, column, definition] of mysqlAddColumns) {
            const [columns] = await connection.execute<RowDataPacket[]>(
              'SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',
              [table, column],
            );
            if (!columns.length)
              await connection.query(
                `ALTER TABLE ${identifier(table)} ADD COLUMN ${identifier(column)} ${definition}`,
              );
          }
          await connection.query(
            'INSERT INTO schema_migrations(version) VALUES(1) ON DUPLICATE KEY UPDATE version=version',
          );
        } finally {
          await connection.execute('SELECT RELEASE_LOCK(?)', [lockName]);
        }
      }
    } finally {
      connection.release();
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    dialect: 'mysql',
    query: <T extends Row>(sql: string, params?: unknown[]) =>
      transaction((tx) => tx.query<T>(sql, params)),
    transaction,
    close: async () => {
      await pool.end();
    },
  };
}
