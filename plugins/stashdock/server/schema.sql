PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stash_items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
  url TEXT, excerpt TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, preview TEXT,
  asset_path TEXT, original_path TEXT, mime_type TEXT, size_bytes INTEGER,
  content TEXT, origin_json TEXT, context_override TEXT, updated_at TEXT NOT NULL,
  preview_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stash_items_created_at ON stash_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stash_items_kind ON stash_items(kind);
CREATE INDEX IF NOT EXISTS idx_stash_items_url ON stash_items(url);
CREATE TABLE IF NOT EXISTS reference_usage (
  id TEXT PRIMARY KEY REFERENCES stash_items(id) ON DELETE CASCADE,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0)
);
CREATE TABLE IF NOT EXISTS reference_usage_receipts (operation_id TEXT PRIMARY KEY);
