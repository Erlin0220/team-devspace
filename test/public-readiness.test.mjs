import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import worker from '../gateway/index.mjs';
import base from '../release.config.json' with { type: 'json' };
import { resolveReleaseProfile, readReleaseProfile, releaseProfileDigest,
  requireProductionProfile, verifyProfileBinding } from '../scripts/release-profile.mjs';
import { deploymentConfig } from '../scripts/private-config.mjs';

const profile = { gateway: 'https://gateway.example.test', downloadOrigin: 'https://downloads.example.test',
  updatePublicKey: 'B'.repeat(43) };

test('an explicit edition changes only public endpoints and trust key, never the source declaration', () => {
  const original = structuredClone(base);
  const resolved = resolveReleaseProfile(base, profile);
  assert.deepEqual(base, original);
  assert.equal(resolved.version, base.version);
  assert.equal(resolved.gateway, profile.gateway);
  assert.equal(resolved.distribution.origin, profile.downloadOrigin);
  assert.equal(resolved.distribution.updatePublicKey, profile.updatePublicKey);
  assert.throws(() => resolveReleaseProfile(base, { ...profile, ADMIN_TOKEN: 'must-not-enter-an-installer' }), /accepts/);
  for (const gateway of ['http://gateway.example.test', 'https://a:b@gateway.example.test', 'https://gateway.example.test/a']) {
    assert.throws(() => resolveReleaseProfile(base, { ...profile, gateway }), /origins/);
  }
  assert.throws(() => requireProductionProfile(base), /explicit/);
  assert.doesNotThrow(() => requireProductionProfile(resolved));
  assert.throws(() => readReleaseProfile({ TEAM_DEVSPACE_RELEASE_PROFILE: 'unused', TEAM_DEVSPACE_RELEASE_PROFILE_JSON: '{}' }), /not both/);
  assert.throws(() => readReleaseProfile({ TEAM_DEVSPACE_RELEASE_PROFILE_JSON: '{bad' }), /Invalid/);
});

test('receipt profile is bound to the packaged edition, not merely the acceptance environment', () => {
  const resolved = resolveReleaseProfile(base, profile);
  const receipt = { release: resolved.version, releaseProfileSha256: releaseProfileDigest(resolved) };
  assert.equal(verifyProfileBinding(resolved, receipt, resolved), receipt.releaseProfileSha256);
  assert.throws(() => verifyProfileBinding(base, receipt, resolved), /Packaged/);
  assert.throws(() => verifyProfileBinding(resolved, { ...receipt, release: '99.0.0' }, resolved), /Packaged/);
  assert.throws(() => verifyProfileBinding(resolved, { ...receipt, releaseProfileSha256: '0'.repeat(64) }, resolved), /Packaged/);
});

test('deployment metadata is separate from installer profiles and rejects secret-shaped extra fields', async () => {
  const value = { zoneId: '0'.repeat(32), databaseId: '00000000-0000-0000-0000-000000000000', accessApplicationId: null };
  assert.deepEqual(await deploymentConfig({ TEAM_DEVSPACE_DEPLOYMENT_JSON: JSON.stringify(value) }), value);
  await assert.rejects(deploymentConfig({ TEAM_DEVSPACE_DEPLOYMENT_JSON: JSON.stringify({ ...value, token: 'private' }) }), /Invalid private/);
  await assert.rejects(deploymentConfig({ TEAM_DEVSPACE_DEPLOYMENT_JSON: '{private' }), error => !error.message.includes('{private'));
});

test('malformed credentials cannot trigger D1 or provider work', async () => {
  let queries = 0;
  const env = { DB: { prepare() { queries++; throw new Error('Unexpected query'); } }, ADMIN_TOKEN: 'T'.repeat(43) };
  for (const path of ['/mcp', '/v1/enroll', '/v1/enrollment/preflight', '/v1/device/version', '/v1/device/status-v2', '/v1/admin/keys']) {
    const response = await worker.fetch(new Request(`https://gateway.example.test${path}`, {
      method: 'POST', headers: { Authorization: 'Bearer malformed', 'Content-Type': 'application/json' }, body: '{}',
    }), env);
    assert.equal(response.status, 401, path);
  }
  assert.equal(queries, 0);
});

test('authenticated enrollment limiter rejects before provisioning and does not key by shared office IP', async () => {
  let queries = 0, observed;
  const row = { id: '11111111-1111-4111-8111-111111111111', state: 'issued' };
  const env = { DB: { prepare() { queries++; return { bind() { return { first: async () => row }; } }; } },
    ENROLLMENT_LIMITER: { async limit(input) { observed = input; return { success: false }; } } };
  const response = await worker.fetch(new Request('https://gateway.example.test/v1/enroll', {
    method: 'POST', headers: { Authorization: `Bearer tds_${'x'.repeat(43)}`, 'Content-Type': 'application/json' }, body: '{}',
  }), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(queries, 1);
  assert.deepEqual(observed, { key: row.id });
});

test('the original PolyForm text and upstream licenses remain in the packaging allow-list', async () => {
  assert.equal(createHash('sha256').update(await readFile('LICENSE')).digest('hex'),
    '67530f8e9adfcc5d2e9d72b804500cebb7472ff84c34a6729a80a2a9be901ee6');
  const distribution = await readFile('scripts/distribution.mjs', 'utf8');
  for (const name of ['LICENSE', 'NOTICE', 'LICENSES']) assert.ok(distribution.includes(`'${name}'`));
  assert.match(await readFile('LICENSES/DevSpace-MIT.txt', 'utf8'), /Copyright \(c\) 2026 Waishnav/);
  assert.match(await readFile('assets/admin/PICO-LICENSE.md', 'utf8'), /MIT License/);
  assert.match(await readFile('LICENSES/cloudflared-LICENSE.txt', 'utf8'), /Apache License/);
});

test('the old Intel handoff remains a protected manual fallback with operator-profile binding', async () => {
  const workflow = await readFile('.github/workflows/accept-codemagic-intel.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request(?:_target)?|workflow_run):/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /TEAM_DEVSPACE_RELEASE_PROFILE_JSON/);
  assert.match(workflow, /vars\.TEAM_DEVSPACE_RELEASE_PROFILE \}\}/);
  assert.match(workflow, /requireProductionProfile\(release\)/);
  assert.match(workflow, /node scripts\/macos-accept-existing\.mjs/);
  const script = await readFile('scripts/macos-accept-existing.mjs', 'utf8');
  assert.match(script, /from '\.\/release-profile\.mjs'/);
  assert.match(script, /prior\.releaseProfileSha256, releaseProfileDigest\(release\)/);
  assert.doesNotMatch(script, /from '\.\.\/release\.config\.json'/);
});
