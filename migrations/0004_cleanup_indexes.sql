CREATE INDEX IF NOT EXISTS idx_access_keys_cleanup_pending_updated_at
  ON access_keys(updated_at) WHERE cleanup_pending = 1;

CREATE INDEX IF NOT EXISTS idx_access_keys_provisioning_updated_at
  ON access_keys(updated_at) WHERE state = 'provisioning';
