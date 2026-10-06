import { z } from 'zod';
import type { Queryable } from './db.js';

const selections = z
  .array(z.string().trim().min(1).max(100))
  .max(20)
  .default([])
  .transform((values) => [...new Set(values)]);
export const audienceFilters = z
  .object({
    departments: selections,
    roles: selections,
    tags: selections,
  })
  .strict();
export const audienceBody = z.object({
  segment: z.enum(['all', 'members', 'guests']),
  filters: audienceFilters.default({ departments: [], roles: [], tags: [] }),
});
export type Audience = z.infer<typeof audienceBody>;

// OR within each filter, AND between filters. Missing SSO claims never match.
const audienceWhere = `NOT u.blocked
  AND ($1='all' OR ($1='members' AND u.cusa_sub IS NOT NULL) OR ($1='guests' AND u.cusa_sub IS NULL))
  AND (cardinality($2::text[])=0 OR (u.cusa_sub IS NOT NULL AND u.department=ANY($2::text[])))
  AND (cardinality($3::text[])=0 OR (u.cusa_sub IS NOT NULL AND u.roles ?| $3::text[]))
  AND (cardinality($4::text[])=0 OR u.interest_tags ?| $4::text[])`;
function params(audience: Audience) {
  return [
    audience.segment,
    audience.filters.departments,
    audience.filters.roles,
    audience.filters.tags,
  ];
}
export async function audienceRecipients(db: Queryable, audience: Audience) {
  return db.query(
    `SELECT u.id,u.line_user_id FROM users u WHERE ${audienceWhere} ORDER BY u.id`,
    params(audience),
  );
}
export async function audienceCount(db: Queryable, audience: Audience) {
  const [row] = await db.query(
    `SELECT count(*)::int AS count FROM users u WHERE ${audienceWhere}`,
    params(audience),
  );
  return row.count as number;
}
export async function audienceOptions(db: Queryable) {
  const departments = await db.query(
    `SELECT DISTINCT department AS value FROM users WHERE cusa_sub IS NOT NULL AND department IS NOT NULL AND NOT blocked ORDER BY value`,
  );
  const roles = await db.query(
    `SELECT DISTINCT jsonb_array_elements_text(roles) AS value FROM users WHERE cusa_sub IS NOT NULL AND NOT blocked ORDER BY value`,
  );
  const tags = await db.query(
    `SELECT DISTINCT jsonb_array_elements_text(interest_tags) AS value FROM users WHERE NOT blocked ORDER BY value`,
  );
  return {
    departments: departments.map((r) => r.value),
    roles: roles.map((r) => r.value),
    tags: tags.map((r) => r.value),
  };
}
