import { validateCatalog } from './release-catalog.mjs';

// Automatic policy deliberately supports final releases only, never prerelease aliases.
export const UPDATE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export const UPDATE_SIGNATURE_CONTEXT = 'TeamDevSpace/update-catalog/v1\n';
const encoder = new TextEncoder();

export function compareVersions(left, right) {
  if (!UPDATE_VERSION.test(left ?? '') || !UPDATE_VERSION.test(right ?? '')) throw new Error('Invalid update version');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function validateUpdatePolicy(policy) {
  if (policy?.schema !== 1 || !UPDATE_VERSION.test(policy.stable ?? '') ||
      !Number.isSafeInteger(policy.revision) || policy.revision < 0) throw new Error('Invalid update policy');
  for (const field of ['auto', 'minimumSupported']) {
    if (policy[field] !== null && (!UPDATE_VERSION.test(policy[field] ?? '') || compareVersions(policy[field], policy.stable) > 0)) {
      throw new Error(`${field} must reference an accepted version at or below stable`);
    }
  }
  if (policy.minimumSupported !== null && (!policy.auto || compareVersions(policy.minimumSupported, policy.auto) > 0)) {
    throw new Error('Minimum supported must first be approved for automatic rollout');
  }
  if (policy.minimumSupported === null ? policy.enforceAfter !== null
    : typeof policy.enforceAfter !== 'string' || !Number.isFinite(Date.parse(policy.enforceAfter)) ||
      new Date(policy.enforceAfter).toISOString() !== policy.enforceAfter) throw new Error('A minimum version requires an explicit UTC enforcement deadline');
  return policy;
}

export function versionUnsupported(version, policy, now = Date.now()) {
  if (!policy.minimumSupported || !policy.enforceAfter || now < Date.parse(policy.enforceAfter)) return false;
  // Legacy clients without inventory still have a manual installation recovery path.
  return !UPDATE_VERSION.test(version ?? '') || compareVersions(version, policy.minimumSupported) < 0;
}

function unbase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid update signature encoding');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
}

export function updateSigningBytes(payload) {
  return encoder.encode(UPDATE_SIGNATURE_CONTEXT + payload);
}

export async function verifySignedCatalog(envelope, publicKey, expectedVersion) {
  if (envelope?.schema !== 1 || typeof envelope.payload !== 'string' || envelope.payload.length > 32768 ||
      typeof envelope.signature !== 'string' || envelope.signature.length !== 86 ||
      typeof publicKey !== 'string' || publicKey.length !== 43) throw new Error('Signed update metadata is required');
  const key = await crypto.subtle.importKey('raw', unbase64url(publicKey), { name: 'Ed25519' }, false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, unbase64url(envelope.signature), updateSigningBytes(envelope.payload))) {
    throw new Error('Update signature verification failed');
  }
  const catalog = validateCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unbase64url(envelope.payload))));
  if (!UPDATE_VERSION.test(catalog.version) || (expectedVersion !== undefined && catalog.version !== expectedVersion)) throw new Error('Signed update release identity differs from the requested version');
  return catalog;
}

export async function boundedJson(response, limit = 65536) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    const value = response.headers.get('Retry-After') ?? '';
    const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
    const retryAfterMs = [429, 503].includes(response.status) && Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds, 86400) * 1000 : 0;
    throw Object.assign(new Error(`Update service returned HTTP ${response.status}`), { retryAfterMs });
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Update metadata exceeds the size limit');
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
