export class KeyStore {
  constructor(database) {
    // Every request starts on the primary. Revocations must not wait for replica/cache expiry.
    this.db = database.withSession ? database.withSession('first-primary') : database;
  }

  byId(id) {
    return this.db.prepare('SELECT * FROM access_keys WHERE id = ?').bind(id).first();
  }

  byHash(hash) {
    return this.db.prepare('SELECT * FROM access_keys WHERE key_hash = ?').bind(hash).first();
  }

  async list() {
    const rows = await this.db.prepare(`SELECT id, label, state, device_id AS deviceId,
      binding_id AS bindingId, hostname, cleanup_pending AS cleanupPending,
      created_at AS createdAt, updated_at AS updatedAt
      FROM access_keys ORDER BY created_at, id`).all();
    return rows.results;
  }

  async issue({ id, label, keyHash }) {
    await this.db.prepare('INSERT OR IGNORE INTO access_keys (id, label, key_hash) VALUES (?, ?, ?)')
      .bind(id, label, keyHash).run();
    const row = await this.byId(id);
    return row?.key_hash === keyHash && row?.label === label ? row : null;
  }

  async bind(keyId, { deviceId, deviceSecretHash, deviceSecretBox, bindingId, bridgePort }) {
    await this.db.prepare(`UPDATE access_keys SET state = 'provisioning', device_id = ?,
      device_secret_hash = ?, device_secret_box = ?, binding_id = ?, bridge_port = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND state = 'issued' AND binding_id IS NULL`)
      .bind(deviceId, deviceSecretHash, deviceSecretBox, bindingId, bridgePort, keyId).run();
    return this.byId(keyId);
  }

  async saveTunnel(id, bindingId, tunnelId, hostname) {
    const result = await this.db.prepare(`UPDATE access_keys SET tunnel_id = ?, hostname = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND binding_id = ? AND state IN ('provisioning', 'active', 'suspended')
      AND (tunnel_id IS NULL OR tunnel_id = ?)`)
      .bind(tunnelId, hostname, id, bindingId, tunnelId).run();
    return result.meta.changes === 1;
  }

  async activate(id, bindingId, dnsId) {
    const result = await this.db.prepare(`UPDATE access_keys SET
      state = CASE WHEN state = 'suspended' THEN 'suspended' ELSE 'active' END, dns_id = ?,
      cleanup_pending = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND binding_id = ? AND state IN ('provisioning', 'active', 'suspended')`)
      .bind(dnsId, id, bindingId).run();
    return result.meta.changes === 1;
  }

  async disable(id, operation) {
    const next = operation === 'revoke' ? 'revoked' : 'resetting';
    const result = await this.db.prepare(`UPDATE access_keys SET state = ?, cleanup_pending = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND (? = 'revoked' OR state != 'revoked')`)
      .bind(next, id, next).run();
    return result.meta.changes === 1 ? this.byId(id) : null;
  }

  async suspend(id, bindingId) {
    const result = await this.db.prepare(`UPDATE access_keys SET state = 'suspended',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND binding_id = ? AND state IN ('active', 'suspended')`)
      .bind(id, bindingId).run();
    return result.meta.changes === 1;
  }

  async resume(id, bindingId) {
    const result = await this.db.prepare(`UPDATE access_keys SET state = 'active',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND binding_id = ? AND state IN ('active', 'suspended')`)
      .bind(id, bindingId).run();
    return result.meta.changes === 1;
  }

  async finishCleanup(id, bindingId, operation) {
    if (operation === 'reset') {
      const result = await this.db.prepare(`UPDATE access_keys SET state = 'issued', device_id = NULL,
        device_secret_hash = NULL, device_secret_box = NULL, binding_id = NULL,
        bridge_port = NULL, tunnel_id = NULL, hostname = NULL, dns_id = NULL, cleanup_pending = 0,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND binding_id IS ? AND state = 'resetting'`)
        .bind(id, bindingId).run();
      return result.meta.changes === 1;
    }
    const result = await this.db.prepare(`UPDATE access_keys SET cleanup_pending = 0,
      device_secret_box = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND binding_id IS ? AND state = 'revoked'`)
      .bind(id, bindingId).run();
    return result.meta.changes === 1;
  }

  async cleanupCandidates(limit = 10) {
    const rows = await this.db.prepare(`SELECT * FROM access_keys
      WHERE cleanup_pending = 1 OR (state = 'provisioning' AND updated_at < datetime('now', '-15 minutes'))
      ORDER BY updated_at LIMIT ?`).bind(limit).all();
    return rows.results;
  }
}
