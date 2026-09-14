import { validateUpdateReport } from '../client/update-report.mjs';

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
    const rows = await this.db.prepare(`SELECT key.id, key.label, key.state, key.device_id AS deviceId,
      key.binding_id AS bindingId, key.hostname, key.cleanup_pending AS cleanupPending,
      key.created_at AS createdAt, key.updated_at AS updatedAt,
      key.client_version AS clientVersion, key.client_platform AS clientPlatform,
      key.version_reported_at AS versionReportedAt, key.update_report AS updateReport,
      lifecycle.revokedAt, lifecycle.cleanupCompletedAt
      FROM access_keys AS key
      LEFT JOIN (
        SELECT key_id,
          MIN(CASE WHEN event = 'revoked' THEN occurred_at END) AS revokedAt,
          MAX(CASE WHEN event = 'revoked_cleanup_completed' THEN occurred_at END) AS cleanupCompletedAt
        FROM access_key_events
        GROUP BY key_id
      ) AS lifecycle ON lifecycle.key_id = key.id
      ORDER BY key.created_at, key.id`).all();
    return rows.results;
  }

  async listEvents(limit = 100) {
    const bounded = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const rows = await this.db.prepare(`SELECT id, key_id AS keyId, label, event, occurred_at AS occurredAt
      FROM access_key_events ORDER BY id DESC LIMIT ?`).bind(bounded).all();
    return rows.results;
  }

  async wasDeleted(id) {
    return Boolean(await this.db.prepare(`SELECT 1 FROM access_key_events
      WHERE key_id = ? AND event = 'deleted' LIMIT 1`).bind(id).first());
  }

  async issue({ id, label, keyHash }) {
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO access_keys (id, label, key_hash)
        SELECT ?, ?, ? WHERE NOT EXISTS (
          SELECT 1 FROM access_key_events WHERE key_id = ? AND event = 'deleted'
        )`).bind(id, label, keyHash, id),
      this.db.prepare(`INSERT INTO access_key_events(key_id, label, event, occurred_at)
        SELECT id, label, 'created', created_at FROM access_keys
        WHERE id = ? AND key_hash = ? AND label = ?
        AND NOT EXISTS (
          SELECT 1 FROM access_key_events WHERE key_id = ? AND event = 'created'
        )`).bind(id, keyHash, label, id),
    ]);
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

  async disable(id, operation, expectedBindingId = null) {
    const next = operation === 'revoke' ? 'revoked' : 'resetting';
    const event = operation === 'revoke' ? 'revoked' : 'reset';
    // Device-authorized changes apply only to the authenticated binding. Return
    // that exact mutation, not a later read that could observe a replacement.
    const [updated] = await this.db.batch([
      this.db.prepare(`UPDATE access_keys SET state = ?, cleanup_pending = 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND (? = 'revoked' OR state != 'revoked')
        AND (? IS NULL OR binding_id = ?) RETURNING *`)
        .bind(next, id, next, expectedBindingId, expectedBindingId),
      this.db.prepare(`INSERT OR IGNORE INTO access_key_events(key_id, label, event, occurred_at)
        SELECT id, label, ?, updated_at FROM access_keys
        WHERE id = ? AND state = ? AND (? IS NULL OR binding_id = ?)`)
        .bind(event, id, next, expectedBindingId, expectedBindingId),
    ]);
    return updated.results?.[0] ?? null;
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
        client_version = NULL, client_platform = NULL, version_reported_at = NULL, update_report = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND binding_id IS ? AND state = 'resetting'`)
        .bind(id, bindingId).run();
      return result.meta.changes === 1;
    }
    const [result] = await this.db.batch([
      this.db.prepare(`UPDATE access_keys SET cleanup_pending = 0,
        device_secret_box = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND binding_id IS ? AND state = 'revoked' AND cleanup_pending = 1`)
        .bind(id, bindingId),
      this.db.prepare(`INSERT OR IGNORE INTO access_key_events(key_id, label, event, occurred_at)
        SELECT key.id, key.label, 'revoked_cleanup_completed', key.updated_at FROM access_keys AS key
        WHERE id = ? AND binding_id IS ? AND state = 'revoked' AND cleanup_pending = 0`)
        .bind(id, bindingId),
    ]);
    return result.meta.changes === 1;
  }

  async deleteRevoked(id) {
    const [, result] = await this.db.batch([
      this.db.prepare(`INSERT INTO access_key_events(key_id, label, event)
        SELECT id, label, 'deleted' FROM access_keys
        WHERE id = ? AND state = 'revoked' AND cleanup_pending = 0`).bind(id),
      this.db.prepare(`DELETE FROM access_keys
        WHERE id = ? AND state = 'revoked' AND cleanup_pending = 0`).bind(id),
    ]);
    return result.meta.changes === 1;
  }

  async deleteAllRevoked() {
    const [, result] = await this.db.batch([
      this.db.prepare(`INSERT INTO access_key_events(key_id, label, event)
        SELECT id, label, 'deleted' FROM access_keys
        WHERE state = 'revoked' AND cleanup_pending = 0`),
      this.db.prepare(`DELETE FROM access_keys
        WHERE state = 'revoked' AND cleanup_pending = 0`),
    ]);
    return result.meta.changes;
  }

  expireProvisioning(row) {
    // Claim only the exact stale snapshot. A repair, rebind or activation that
    // won the race must never be undone by a delayed cleanup scan.
    return this.db.prepare(`UPDATE access_keys SET state = 'resetting', cleanup_pending = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND binding_id IS ? AND state = 'provisioning' AND updated_at = ?
      AND julianday(updated_at) < julianday('now', '-15 minutes') RETURNING *`)
      .bind(row.id, row.binding_id, row.updated_at).first();
  }

  updatePolicy() {
    return this.db.prepare('SELECT * FROM update_policy WHERE id = 1').first();
  }

  saveUpdatePolicy({ auto, minimumSupported, enforceAfter, revision }) {
    // Prevent two administrators from overwriting each other's promotion decision.
    return this.db.prepare(`UPDATE update_policy SET auto_version = ?, minimum_supported = ?,
      enforce_after = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 1 AND revision = ? AND publication_until <= ? RETURNING *`)
      .bind(auto, minimumSupported, enforceAfter, revision, Date.now()).first();
  }

  claimPublication(token) {
    const now = Date.now();
    return this.db.prepare(`UPDATE update_policy SET publication_token = ?, publication_until = ?
      WHERE id = 1 AND (publication_until <= ? OR publication_token = ?) RETURNING *`)
      .bind(token, now + 15 * 60 * 1000, now, token).first();
  }

  releasePublication(token) {
    return this.db.prepare(`UPDATE update_policy SET publication_token = NULL, publication_until = 0
      WHERE id = 1 AND publication_token = ?`).bind(token).run();
  }

  reportVersion(id, bindingId, version, platform, updateReport) {
    const hasReport = updateReport !== undefined;
    const report = hasReport && updateReport !== null ? JSON.stringify(validateUpdateReport(updateReport)) : null;
    // Startup/upgrade plus low-frequency check-in only. Repeated starts with the
    // same version do not generate writes on the desktop's five-second refresh.
    return this.db.prepare(`UPDATE access_keys SET client_version = ?, client_platform = ?,
      update_report = CASE WHEN ? THEN ?
        WHEN client_version IS NOT ? OR client_platform IS NOT ? THEN NULL ELSE update_report END,
      version_reported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND binding_id = ? AND state IN ('active', 'suspended')
      AND (client_version IS NOT ? OR client_platform IS NOT ? OR version_reported_at IS NULL
        OR julianday(version_reported_at) <= julianday('now', '-6 hours') OR (? AND update_report IS NOT ?))`)
      .bind(version, platform, hasReport ? 1 : 0, report, version, platform,
        id, bindingId, version, platform, hasReport ? 1 : 0, report).run();
  }

  async cleanupCandidates(limit = 10, now = Date.now()) {
    const cutoff = new Date(now - 15 * 60 * 1000).toISOString();
    // Keep both predicates indexable. A single OR query forced a full-table scan
    // every five minutes and grew linearly with retained revoked keys.
    const [pending, staleProvisioning] = await Promise.all([
      this.db.prepare(`SELECT * FROM access_keys WHERE cleanup_pending = 1
        ORDER BY updated_at LIMIT ?`).bind(limit).all(),
      this.db.prepare(`SELECT * FROM access_keys WHERE state = 'provisioning' AND updated_at < ?
        ORDER BY updated_at LIMIT ?`).bind(cutoff, limit).all(),
    ]);
    const unique = new Map();
    for (const row of [...pending.results, ...staleProvisioning.results]) unique.set(row.id, row);
    return [...unique.values()].sort((left, right) => left.updated_at.localeCompare(right.updated_at)).slice(0, limit);
  }
}
