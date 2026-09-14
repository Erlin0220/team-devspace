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
    updatedAt: value(row, 'updated_at', 'updatedAt'),
    cleanupPending: Boolean(value(row, 'cleanup_pending', 'cleanupPending')),
    clientVersion: value(row, 'client_version', 'clientVersion'),
    clientPlatform: value(row, 'client_platform', 'clientPlatform'),
    versionReportedAt: value(row, 'version_reported_at', 'versionReportedAt'),
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

  async issueKey(input) {
    const row = await this.store.issue(input);
    if (!row) throw new AdminServiceError(409, 'key_label_or_id_conflict');
    return publicAccessKey(row);
  }

  revokeKey(id) { return this.changeLifecycle(id, 'revoke'); }

  resetDevice(id) { return this.changeLifecycle(id, 'reset'); }

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
