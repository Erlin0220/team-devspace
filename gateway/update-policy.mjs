import release from '../release.config.json' with { type: 'json' };
import { boundedJson, compareVersions, UPDATE_VERSION, validateUpdatePolicy, verifySignedCatalog } from '../client/update-policy.mjs';
import { validateCatalog } from '../client/release-catalog.mjs';
import { AdminServiceError } from './admin-service.mjs';

const cache = new Map();
const origin = release.distribution.origin;
const rules = row => ({ schema: 1, auto: row.auto_version, minimumSupported: row.minimum_supported,
  enforceAfter: row.enforce_after, revision: row.revision });
// workerd accepts manual/follow, not Node's redirect:error. boundedJson rejects
// every non-2xx response, so a redirect can never change the trusted origin.
const fetchJson = async url => boundedJson(await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) }));

// This cache never covers device authorization, reset or revoke. Only fleet policy
// has a documented <=60-second propagation delay, with no per-request D1 writes.
export async function updateRules(env, store, fresh = false) {
  const key = env.PUBLIC_ORIGIN;
  const previous = cache.get(key);
  if (!fresh && previous?.expires > Date.now()) return previous.value;
  const row = await store.updatePolicy();
  if (!row) throw new Error('Update policy migration is missing');
  const value = rules(row);
  if (cache.size > 16) cache.clear();
  cache.set(key, { value, expires: Date.now() + 60000 });
  return value;
}

export function clearUpdatePolicyCache(env) { cache.delete(env.PUBLIC_ORIGIN); }

export async function publicUpdatePolicy(env, store) {
  const [rule, catalog] = await Promise.all([updateRules(env, store), fetchJson(`${origin}/catalog.json`)]);
  return validateUpdatePolicy({ ...rule, stable: validateCatalog(catalog).version });
}

function validateReleaseIndex(value) {
  if (value?.schema !== 1 || !Array.isArray(value.versions) || value.versions.length > 64 ||
      value.versions.some(version => !UPDATE_VERSION.test(version ?? '')) ||
      new Set(value.versions).size !== value.versions.length) throw new Error('Invalid release index');
  return value.versions;
}

async function selectableVersions(policy) {
  let candidates;
  try { candidates = validateReleaseIndex(await fetchJson(`${origin}/releases.json`)); }
  catch { candidates = []; }
  const pinned = [policy.stable, policy.auto, policy.minimumSupported].filter(Boolean);
  for (const version of pinned) {
    if (version && !candidates.includes(version)) candidates.push(version);
  }
  const verified = [];
  for (const version of candidates) {
    if (compareVersions(version, policy.stable) > 0) continue;
    try {
      await verifySignedCatalog(await fetchJson(`${origin}/releases/${version}/update.json`),
        release.distribution.updatePublicKey, version);
      verified.push(version);
    } catch {}
  }
  // Never hide the already-active policy from the editor during a transient
  // distribution outage. New choices still come only from verified signed releases.
  return [...new Set([...verified, ...pinned])]
    .filter(version => compareVersions(version, policy.stable) <= 0)
    .sort((left, right) => compareVersions(right, left));
}

export async function adminUpdatePolicy(env, store) {
  const policy = await publicUpdatePolicy(env, store);
  return { ...policy, selectableVersions: await selectableVersions(policy) };
}

export async function saveUpdatePolicy(env, store, input) {
  if (!input || Object.keys(input).sort().join() !== 'auto,enforceAfter,minimumSupported,revision') {
    throw new AdminServiceError(400, 'invalid_update_policy');
  }
  const row = await store.updatePolicy();
  if (row.publication_until > Date.now()) throw new AdminServiceError(409, 'update_publication_in_progress');
  // A deliberate stable rollback must not make the policy editor itself unusable.
  const current = { ...rules(row), stable: validateCatalog(await fetchJson(`${origin}/catalog.json`)).version };
  let policy;
  try { policy = validateUpdatePolicy({ ...input, schema: 1, stable: current.stable }); }
  catch { throw new AdminServiceError(400, 'invalid_update_policy'); }
  if (current.revision !== policy.revision) throw new AdminServiceError(409, 'update_policy_changed');
  // Approval cannot name unpublished, incomplete or unsigned release bytes.
  for (const version of new Set([policy.auto, policy.minimumSupported].filter(Boolean))) {
    try { await verifySignedCatalog(await fetchJson(`${origin}/releases/${version}/update.json`), release.distribution.updatePublicKey, version); }
    catch { throw new AdminServiceError(409, 'update_release_not_verified'); }
  }
  const saved = await store.saveUpdatePolicy(policy);
  if (!saved) throw new AdminServiceError(409, 'update_policy_changed');
  clearUpdatePolicyCache(env);
  return { ...rules(saved), stable: current.stable };
}

export async function publicationLease(store, input) {
  if (!input || !['begin', 'end'].includes(input.action) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.token ?? '') ||
      Object.keys(input).sort().join() !== 'action,token') throw new AdminServiceError(400, 'invalid_publication_request');
  if (input.action === 'end') { await store.releasePublication(input.token); return { released: true }; }
  const row = await store.claimPublication(input.token);
  if (!row) throw new AdminServiceError(409, 'update_publication_in_progress');
  return { expiresAt: row.publication_until, policy: rules(row) };
}
