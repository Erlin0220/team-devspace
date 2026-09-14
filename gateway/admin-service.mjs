import { parseUpdateReport } from '../client/update-report.mjs';

export class AdminServiceError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'AdminServiceError';
    this.status = status;
    this.code = code;
  }
}

const value = (row, snake, camel) => row?.[camel] ?? row?.[snake] ?? null;

export function publicAccessKey(row) {
  return {
    id: row.id,
    label: row.label,
    state: row.state,
    deviceId: value(row, 'device_id', 'deviceId'),
    bindingId: value(row, 'binding_id', 'bindingId'),
    createdAt: value(row, 'created_at', 'createdAt'),
    updatedAt: value(row, 'updated_at', 'updatedAt'),
    revokedAt: value(row, 'revoked_at', 'revokedAt'),
    cleanupCompletedAt: value(row, 'cleanup_completed_at', 'cleanupCompletedAt'),
    cleanupPending: Boolean(value(row, 'cleanup_pending', 'cleanupPending')),
    clientVersion: value(row, 'client_version', 'clientVersion'),
    clientPlatform: value(row, 'client_platform', 'clientPlatform'),
    versionReportedAt: value(row, 'version_reported_at', 'versionReportedAt'),
    updateReport: parseUpdateReport(value(row, 'update_report', 'updateReport')),
  };
}

export class AdminService {
  constructor(store, cloud) {
    this.store = store;
    this.cloud = cloud;
  }

  async listKeys() {
    return (await this.store.list()).map(publicAccessKey);
  }

  async listKeyEvents(limit = 100) {
    return this.store.listEvents(limit);
  }

  async issueKey(input) {
    const row = await this.store.issue(input);
    if (!row) {
      if (await this.store.wasDeleted(input.id)) throw new AdminServiceError(409, 'deleted_key_id_cannot_be_reused');
      throw new AdminServiceError(409, 'key_label_or_id_conflict');
    }
    return publicAccessKey(row);
  }

  revokeKey(id) { return this.changeLifecycle(id, 'revoke'); }

  resetDevice(id) { return this.changeLifecycle(id, 'reset'); }

  async deleteRevokedKey(id) {
    const row = await this.store.byId(id);
    if (!row) throw new AdminServiceError(404, 'key_not_found');
    if (row.state !== 'revoked' || Boolean(value(row, 'cleanup_pending', 'cleanupPending'))) {
      throw new AdminServiceError(409, 'revoked_key_not_ready_for_delete');
    }
    if (!await this.store.deleteRevoked(id)) throw new AdminServiceError(409, 'access_lifecycle_changed');
    return { deleted: id };
  }

  async deleteAllRevokedKeys() {
    return { deleted: await this.store.deleteAllRevoked() };
  }

  async changeLifecycle(id, operation) {
    if (!await this.store.byId(id)) throw new AdminServiceError(404, 'key_not_found');
    // Commit denial before external cleanup. Failures remain denied and retryable.
    const row = await this.store.disable(id, operation);
    if (!row) throw new AdminServiceError(409, 'revoked_key_cannot_be_reset');
    try { await this.cloud.remove(row); }
    catch {
      return { key: publicAccessKey(row), cleanup: 'pending',
        error: 'connectivity_cleanup_pending', retryable: true };
    }
    if (!await this.store.finishCleanup(id, row.binding_id, operation)) {
      throw new AdminServiceError(409, 'access_lifecycle_changed');
    }
    return { key: publicAccessKey(await this.store.byId(id)), cleanup: 'complete' };
  }
}
