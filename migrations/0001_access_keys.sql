CREATE TABLE IF NOT EXISTS access_keys (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'issued'
    CHECK (state IN ('issued', 'provisioning', 'active', 'resetting', 'revoked')),
  device_id TEXT,
  device_secret_hash TEXT,
  device_secret_box TEXT,
  binding_id TEXT UNIQUE,
  bridge_port INTEGER,
  tunnel_id TEXT,
  hostname TEXT,
  dns_id TEXT,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (bridge_port IS NULL OR (bridge_port BETWEEN 1024 AND 65535))
);
