-- SocialPlan ilk şema. Tüm zamanlar UTC ISO-8601 metin.

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  avatar_key TEXT,
  color TEXT NOT NULL DEFAULT '#6366f1',
  timezone TEXT NOT NULL DEFAULT 'Europe/Istanbul',
  paused INTEGER NOT NULL DEFAULT 0,
  autofill_enabled INTEGER NOT NULL DEFAULT 0,
  autofill_days INTEGER NOT NULL DEFAULT 7,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  platform TEXT NOT NULL CHECK (platform IN ('instagram','youtube','tiktok')),
  mode TEXT NOT NULL CHECK (mode IN ('auto','inbox')),
  external_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  avatar_url TEXT,
  secret_blob TEXT,
  secret_key_version INTEGER NOT NULL DEFAULT 1,
  token_expires_at TEXT,
  refresh_expires_at TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','reconnect','disabled')),
  last_refreshed_at TEXT,
  last_error TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, external_id),
  UNIQUE (brand_id, platform)
);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  r2_key TEXT NOT NULL,
  thumbnail_key TEXT,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  fps REAL,
  video_codec TEXT,
  audio_codec TEXT,
  bitrate_kbps REAL,
  moov_at_start INTEGER,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '[]',
  caption_overrides TEXT NOT NULL DEFAULT '{}',
  ai_generated INTEGER,
  made_for_kids INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  queue_position REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('uploading','ready','invalid','assigned','published','archived')),
  validation TEXT,
  multipart_upload_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_videos_queue ON videos (brand_id, status, queue_position);
CREATE INDEX idx_videos_hash ON videos (content_hash);

CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  time_local TEXT NOT NULL,
  platforms TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (brand_id, weekday, time_local)
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  video_id TEXT NOT NULL REFERENCES videos(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  platform TEXT NOT NULL CHECK (platform IN ('instagram','youtube','tiktok')),
  slot_id TEXT,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','scheduled','processing','inbox_sent','published','needs_action','failed','cancelled')),
  step TEXT,
  platform_state TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  commit_started_at TEXT,
  external_id TEXT,
  external_url TEXT,
  visibility TEXT,
  error_class TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  caption_snapshot TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_posts_video_account ON posts (video_id, account_id) WHERE status <> 'cancelled';
CREATE INDEX idx_posts_status_time ON posts (status, scheduled_at);
CREATE INDEX idx_posts_brand_time ON posts (brand_id, scheduled_at);
CREATE INDEX idx_posts_external ON posts (platform, external_id);

CREATE TABLE post_events (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  trace_id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  step TEXT,
  detail TEXT
);
CREATE INDEX idx_post_events_post ON post_events (post_id, at);

CREATE TABLE metrics (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  fetched_at TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  raw TEXT
);
CREATE INDEX idx_metrics_post ON metrics (post_id, fetched_at);

CREATE TABLE quota_usage (
  platform TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (platform, scope_key, day, bucket)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  code_verifier TEXT,
  created_by TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  sent_at TEXT NOT NULL,
  payload TEXT
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT
);
CREATE INDEX idx_audit_at ON audit_log (at);

INSERT INTO settings (key, value, updated_by, updated_at) VALUES
  ('kill_switch', 'false', 'migration', '2026-11-05T00:00:00.000Z'),
  ('youtube_audited', 'false', 'migration', '2026-11-05T00:00:00.000Z'),
  ('missed_slot_grace_min', '30', 'migration', '2026-11-05T00:00:00.000Z'),
  ('retention_days', '30', 'migration', '2026-11-05T00:00:00.000Z'),
  ('notify', '{"slack":false,"telegram":false}', 'migration', '2026-11-05T00:00:00.000Z'),
  ('autofill_default_days', '7', 'migration', '2026-11-05T00:00:00.000Z');
