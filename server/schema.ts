export const schema = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('ADMIN','AGENT','REVIEWER')),
  active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY, agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), line_user_id TEXT NOT NULL UNIQUE,
  cusa_sub TEXT UNIQUE, email TEXT, name TEXT NOT NULL, department TEXT,
  roles JSONB NOT NULL DEFAULT '[]', avatar_color TEXT NOT NULL DEFAULT 'sage',
  blocked BOOLEAN NOT NULL DEFAULT false, rich_menu_id TEXT, linked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), number BIGSERIAL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'BOT'
    CHECK (status IN ('BOT','WAITING_FOR_AGENT','AGENT_IN_CHARGE','CLOSED')),
  subject TEXT NOT NULL DEFAULT 'บทสนทนาใหม่', category TEXT NOT NULL DEFAULT 'ทั่วไป',
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','HIGH')),
  assigned_agent_id UUID REFERENCES agents(id), tags JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handover_at TIMESTAMPTZ, claimed_at TIMESTAMPTZ, closed_at TIMESTAMPTZ,
  resolution TEXT, close_note TEXT, last_reminded_at TIMESTAMPTZ,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_conversation ON conversations(user_id) WHERE status <> 'CLOSED';
CREATE INDEX IF NOT EXISTS conversation_queue ON conversations(status, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sequence BIGSERIAL UNIQUE,
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('USER','BOT','AGENT','SYSTEM')),
  agent_id UUID REFERENCES agents(id), kind TEXT NOT NULL DEFAULT 'text',
  encrypted_text TEXT, encrypted_payload TEXT, redacted_text TEXT NOT NULL DEFAULT '',
  delivery_status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (delivery_status IN
    ('RECEIVED','QUEUED','ACCEPTED','FAILED','UNKNOWN','SIMULATED','CANCELLED')),
  internal BOOLEAN NOT NULL DEFAULT false, line_message_id TEXT UNIQUE,
  client_request_id UUID UNIQUE, reply_token TEXT, reply_received_at TIMESTAMPTZ, reply_reserved BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}', attachment_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), withdrawn_at TIMESTAMPTZ
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS encrypted_payload TEXT;
CREATE INDEX IF NOT EXISTS message_timeline ON messages(conversation_id, created_at, sequence);
CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID NOT NULL REFERENCES messages(id),
  filename TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
  storage_path TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY, encrypted_payload TEXT, status TEXT NOT NULL DEFAULT 'PENDING',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS withdrawn_line_messages (
  line_message_id TEXT PRIMARY KEY, line_user_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), kind TEXT NOT NULL, payload JSONB NOT NULL,
  dedupe_key TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0, run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ, lease_token UUID, last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS job_queue ON jobs(status, run_at);
CREATE TABLE IF NOT EXISTS knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL, content TEXT NOT NULL,
  category TEXT NOT NULL, keywords JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  version INTEGER NOT NULL DEFAULT 1, published_content TEXT, published_title TEXT,
  published_keywords JSONB NOT NULL DEFAULT '[]', embedding vector, embedding_model TEXT,
  created_by UUID NOT NULL REFERENCES agents(id), updated_by UUID NOT NULL REFERENCES agents(id),
  approved_by UUID REFERENCES agents(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS knowledge_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), knowledge_id UUID NOT NULL REFERENCES knowledge(id),
  version INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, keywords JSONB NOT NULL,
  approved_by UUID NOT NULL REFERENCES agents(id), published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(knowledge_id, version)
);
CREATE TABLE IF NOT EXISTS training_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL REFERENCES conversations(id),
  source_message_ids JSONB NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '[]', category TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','REJECTED','REVOKED')),
  created_by UUID NOT NULL REFERENCES agents(id), reviewed_by UUID REFERENCES agents(id),
  reviewed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS datasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), version BIGSERIAL UNIQUE, name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES agents(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dataset_items (
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  example_id UUID NOT NULL REFERENCES training_examples(id),
  split TEXT NOT NULL CHECK (split IN ('train','validation','test')),
  snapshot JSONB, revoked_at TIMESTAMPTZ, PRIMARY KEY(dataset_id, example_id)
);
CREATE TABLE IF NOT EXISTS broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title TEXT NOT NULL, content TEXT NOT NULL,
  segment TEXT NOT NULL CHECK (segment IN ('all','members','guests')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SCHEDULED','SENDING','COMPLETED','FAILED','CANCELLED')),
  scheduled_at TIMESTAMPTZ, created_by UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS broadcast_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), broadcast_id UUID NOT NULL REFERENCES broadcasts(id),
  recipient_ids JSONB NOT NULL, retry_key UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'PENDING', accepted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY, agent_id UUID REFERENCES agents(id), action TEXT NOT NULL,
  entity_type TEXT NOT NULL, entity_id TEXT, details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sso_transactions (
  state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, line_user_id TEXT NOT NULL,
  verifier TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS filters JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS interest_tags JSONB NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS rich_menu_target TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rich_menu_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rich_menu_status TEXT NOT NULL DEFAULT 'UNCHANGED';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS supervisor_alert_status TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS supervisor_notified_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS user_interest_tags ON users USING gin(interest_tags);
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id UUID NOT NULL REFERENCES teams(id), agent_id UUID NOT NULL REFERENCES agents(id), PRIMARY KEY(team_id,agent_id)
);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES teams(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS routing_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS case_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL REFERENCES conversations(id),
  from_team_id UUID REFERENCES teams(id), to_team_id UUID NOT NULL REFERENCES teams(id),
  from_agent_id UUID REFERENCES agents(id), to_agent_id UUID REFERENCES agents(id), created_by UUID NOT NULL REFERENCES agents(id),
  from_team_name TEXT, to_team_name TEXT NOT NULL, from_agent_name TEXT, to_agent_name TEXT,
  encrypted_reason TEXT, redacted_reason TEXT NOT NULL, request_id UUID NOT NULL UNIQUE,
  routing_version INTEGER NOT NULL, accepted_by UUID REFERENCES agents(id), accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(conversation_id,routing_version)
);
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), agent_id UUID NOT NULL REFERENCES agents(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id), transfer_id UUID NOT NULL REFERENCES case_transfers(id),
  title TEXT NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(agent_id,transfer_id)
);
CREATE INDEX IF NOT EXISTS ticket_queue ON conversations(team_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS notification_inbox ON notifications(agent_id,created_at DESC);
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
`;
