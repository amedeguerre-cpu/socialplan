-- Metin şablonları, hashtag setleri, marka imzası.
CREATE TABLE caption_templates (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  kind TEXT NOT NULL CHECK (kind IN ('caption','hashtags')),
  name TEXT NOT NULL,
  platform TEXT CHECK (platform IS NULL OR platform IN ('instagram','youtube','tiktok')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (brand_id, kind, name)
);
ALTER TABLE brands ADD COLUMN caption_signature TEXT NOT NULL DEFAULT '';
INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('weekly_report', 'true', 'migration', '2026-11-05T00:00:00.000Z');
