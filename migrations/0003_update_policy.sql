/* Additive: older Workers/clients can continue using the existing binding schema. */
ALTER TABLE access_keys ADD COLUMN client_version TEXT;
ALTER TABLE access_keys ADD COLUMN client_platform TEXT;
ALTER TABLE access_keys ADD COLUMN version_reported_at TEXT;

CREATE TABLE IF NOT EXISTS update_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto_version TEXT,
  minimum_supported TEXT,
  enforce_after TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  publication_token TEXT,
  publication_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO update_policy (id) VALUES (1);
