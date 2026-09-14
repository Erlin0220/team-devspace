CREATE TABLE IF NOT EXISTS access_key_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  label TEXT NOT NULL,
  event TEXT NOT NULL
    CHECK (event IN ('created', 'revoked', 'revoked_cleanup_completed', 'reset', 'deleted')),
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_access_key_events_key_event_time
  ON access_key_events(key_id, event, occurred_at);

CREATE INDEX IF NOT EXISTS idx_access_key_events_time
  ON access_key_events(occurred_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_access_key_events_exact
  ON access_key_events(key_id, event, occurred_at);

/* Preserve the creation timestamp for credentials that predate this audit table. */
INSERT INTO access_key_events(key_id, label, event, occurred_at)
SELECT id, label, 'created', created_at
FROM access_keys AS key
WHERE NOT EXISTS (
  SELECT 1 FROM access_key_events AS event
  WHERE event.key_id = key.id AND event.event = 'created'
);

/* For legacy revoked rows we can recover the cleanup-completed time from the
   last persisted mutation, but the original revoke time was never recorded. */
INSERT INTO access_key_events(key_id, label, event, occurred_at)
SELECT id, label, 'revoked_cleanup_completed', updated_at
FROM access_keys AS key
WHERE state = 'revoked' AND cleanup_pending = 0
  AND NOT EXISTS (
    SELECT 1 FROM access_key_events AS event
    WHERE event.key_id = key.id AND event.event = 'revoked_cleanup_completed'
  );
