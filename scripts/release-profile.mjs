import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import base from '../release.config.json' with { type: 'json' };

// Only public, client-visible settings belong in an edition profile. Never put
// Cloudflare credentials/resource IDs or an update signing private key here.
export function resolveReleaseProfile(source = base, profile = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      Object.keys(profile).some(key => !['gateway', 'downloadOrigin', 'updatePublicKey'].includes(key))) {
    throw new Error('Release profile accepts gateway, downloadOrigin and updatePublicKey only');
  }
  const result = structuredClone(source);
  if (profile.gateway !== undefined) result.gateway = profile.gateway;
  if (profile.downloadOrigin !== undefined) result.distribution.origin = profile.downloadOrigin;
  if (profile.updatePublicKey !== undefined) result.distribution.updatePublicKey = profile.updatePublicKey;
  for (const value of [result.gateway, result.distribution.origin]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
      throw new Error('Release endpoints must be bare HTTPS origins');
    }
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(result.distribution.updatePublicKey)) throw new Error('Invalid Ed25519 public key');
  delete result.cloudflareZoneId;
  return result;
}

export function readReleaseProfile(env = process.env) {
  if (env.TEAM_DEVSPACE_RELEASE_PROFILE && env.TEAM_DEVSPACE_RELEASE_PROFILE_JSON) {
    throw new Error('Choose a release profile file OR environment JSON, not both');
  }
  const text = env.TEAM_DEVSPACE_RELEASE_PROFILE_JSON ||
    (env.TEAM_DEVSPACE_RELEASE_PROFILE ? readFileSync(env.TEAM_DEVSPACE_RELEASE_PROFILE, 'utf8') : '{}');
  let profile;
  try { profile = JSON.parse(text); } catch { throw new Error('Invalid release profile JSON'); }
  return resolveReleaseProfile(base, profile);
}

export const releaseProfileDigest = release => createHash('sha256').update(JSON.stringify({
  gateway: release.gateway, downloadOrigin: release.distribution.origin, updatePublicKey: release.distribution.updatePublicKey,
})).digest('hex');

export function verifyProfileBinding(packaged, provenance, expected) {
  const actual = releaseProfileDigest(packaged);
  if (actual !== releaseProfileDigest(expected) || provenance.releaseProfileSha256 !== actual ||
      packaged.version !== expected.version || provenance.release !== expected.version) {
    throw new Error('Packaged release edition differs from the requested acceptance profile');
  }
  return actual;
}

export function requireProductionProfile(release) {
  if ([release.gateway, release.distribution.origin].some(value => new URL(value).hostname.endsWith('.example.com')) ||
      release.distribution.updatePublicKey === 'A'.repeat(43)) {
    throw new Error('Production operation requires an explicit operator release profile');
  }
}

export default readReleaseProfile();
