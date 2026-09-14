import { control } from './http.mjs';

export async function readGatewayStatus(state, { request = control, now = Date.now } = {}) {
  if (!state.bindingId) return { state: 'not-enrolled', checkedAt: null };
  const value = await request(state.gateway, '/v1/device/status-v2', state.deviceSecret, {
    body: { keyId: state.keyId, bindingId: state.bindingId }, timeout: 5000,
  }).then(result => ['active', 'suspended'].includes(result?.state) && result.bindingId === state.bindingId
    ? result.state : 'invalid-response', error => error.status === 403 ? 'disabled' : 'unreachable');
  return { state: value, checkedAt: new Date(now()).toISOString() };
}

// Desktop presentation cache only. CLI, diagnostics and lifecycle operations use
// fresh reads; Gateway authorization continues to read D1 for EVERY MCP request.
export function createGatewayStatusProbe({ request = control, now = Date.now,
  ttl = 300000, failureTtl = 30000 } = {}) {
  let entry;
  const probe = (state, { force = false } = {}) => {
    if (!state.bindingId) { entry = undefined; return Promise.resolve({ state: 'not-enrolled', checkedAt: null }); }
    // Include identity and local intent so a replacement or pause cannot reuse
    // the previous binding's display state. This value never leaves this closure.
    const key = JSON.stringify([state.gateway, state.keyId, state.bindingId, state.deviceSecret, state.remoteAccess]);
    if (!force && entry?.key === key) {
      if (entry.pending) return entry.pending;
      if (now() < entry.until) return Promise.resolve(entry.result);
    }
    const current = { key };
    entry = current;
    current.pending = readGatewayStatus(state, { request, now }).then(result => {
      current.result = result;
      current.until = now() + (['active', 'suspended', 'disabled'].includes(result.state) ? ttl : failureTtl);
      current.pending = null;
      return result;
    });
    return current.pending;
  };
  // Detach the entry, including any old in-flight read. Its late completion
  // cannot repopulate the cache after a lifecycle transaction.
  probe.invalidate = () => { entry = undefined; };
  return probe;
}
