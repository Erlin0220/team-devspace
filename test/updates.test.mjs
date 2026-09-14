import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { boundedJson, compareVersions, validateUpdatePolicy, verifySignedCatalog, versionUnsupported } from '../client/update-policy.mjs';
import { applyUpdate, checkForUpdates, downloadVerifiedPackage, setAutomaticUpdates, updateStatus } from '../client/updates.mjs';
import { atomicJson, RELEASE_VERSION } from '../client/state.mjs';
import { updateTestCatalog, updateTestBytes, updateTestPublicKey, signUpdateFixture } from './update-fixture.mjs';

const NEXT_VERSION = '0.2.6';
const policy = overrides => ({ schema: 1, stable: NEXT_VERSION, auto: null, minimumSupported: null, enforceAfter: null, revision: 0, ...overrides });
const nextCatalog = () => updateTestCatalog(NEXT_VERSION);
async function temporary(t) {
  const home = await mkdtemp(join(tmpdir(), 'tds-updates-test-'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}

test('update metadata APIs work in the actual Workers runtime without Node-only stream behavior', async t => {
  const script = (await build({ stdin: { contents: `import { boundedJson } from './client/update-policy.mjs';
    export default { async fetch() { try { const response = await fetch('https://metadata.test/catalog.json', { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      return Response.json(await boundedJson(response)); } catch (error) { return Response.json({ name: error.name, message: error.message, stack: error.stack }, { status: 500 }); } } };`,
    resolveDir: resolve('.') }, bundle: true, platform: 'browser', format: 'esm', write: false })).outputFiles[0].text;
  const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-06-01', log: new Log(LogLevel.ERROR),
    outboundService: () => Response.json(nextCatalog()) });
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch('https://worker.test');
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, nextCatalog());
});

test('version policy uses numeric ordering and explicit grace, never aliases or unsupported prereleases', () => {
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const invalid of ['latest', '0.2.4-rc1', '00.2.4', '../0.2.4', '1.2']) assert.throws(() => compareVersions(invalid, '0.2.4'));
  assert.throws(() => validateUpdatePolicy(policy({ auto: '0.2.7' })));
  assert.throws(() => validateUpdatePolicy(policy({ minimumSupported: '0.2.4', enforceAfter: new Date().toISOString() })));
  assert.throws(() => validateUpdatePolicy(policy({ auto: NEXT_VERSION, minimumSupported: '0.2.4', enforceAfter: 'tomorrow' })));
  const p = validateUpdatePolicy(policy({ auto: NEXT_VERSION, minimumSupported: '0.2.4', enforceAfter: '2026-09-15T00:00:00.000Z' }));
  assert.equal(versionUnsupported('0.2.3', p, Date.parse('2026-09-14T00:00:00Z')), false);
  assert.equal(versionUnsupported('0.2.3', p, Date.parse('2026-09-16T00:00:00Z')), true);
  assert.equal(versionUnsupported(null, p, Date.parse('2026-09-16T00:00:00Z')), true);
  assert.equal(versionUnsupported('0.2.4', p, Date.parse('2026-09-16T00:00:00Z')), false);
});

test('signed catalogs bind all package bytes, target identities and release version to the independent key', async () => {
  const catalog = nextCatalog(), signed = await signUpdateFixture(catalog);
  assert.deepEqual(await verifySignedCatalog(signed, updateTestPublicKey, catalog.version), catalog);
  await assert.rejects(verifySignedCatalog({ ...signed, signature: 'a'.repeat(86) }, updateTestPublicKey, catalog.version), /signature/);
  await assert.rejects(verifySignedCatalog(signed, updateTestPublicKey, '0.2.7'), /identity/);
  const changed = { ...catalog, targets: { ...catalog.targets, 'win32-x64': { ...catalog.targets['win32-x64'], sha256: 'b'.repeat(64) } } };
  await assert.rejects(verifySignedCatalog({ ...signed, payload: Buffer.from(JSON.stringify(changed)).toString('base64url') }, updateTestPublicKey, catalog.version), /signature/);
  const partial = await signUpdateFixture({ ...catalog, targets: { 'win32-x64': catalog.targets['win32-x64'] } });
  await assert.rejects(verifySignedCatalog(partial, updateTestPublicKey, catalog.version), /four targets/);
  await assert.rejects(verifySignedCatalog({ schema: 1, ...catalog }, updateTestPublicKey, catalog.version), /Signed update metadata/);
});

test('metadata reader rejects oversized and unsuccessful responses', async () => {
  await assert.rejects(boundedJson(new Response('x'.repeat(65537))), /size limit/);
  await assert.rejects(boundedJson(new Response('redirect', { status: 302 })), /HTTP 302/);
});

test('checks persist jittered deadlines across restarts and upgrade forces fresh version reporting', async t => {
  const home = await temporary(t); let calls = 0;
  const now = Date.now();
  const fetcher = async () => { calls++; return Response.json(policy()); };
  const first = await checkForUpdates(home, { fetcher, now });
  assert.equal(first.available, true); assert.equal(calls, 1);
  assert.ok(first.nextCheckAt >= now + 6 * 3600000 && first.nextCheckAt < now + 7 * 3600000);
  await checkForUpdates(home, { fetcher, now: now + 10000 }); assert.equal(calls, 1);
  await atomicJson(join(home, 'updates/check.json'), { ...first, currentVersion: '0.2.3' });
  await checkForUpdates(home, { fetcher, now: now + 20000 }); assert.equal(calls, 2);
  await setAutomaticUpdates(false, home); assert.equal((await updateStatus(home)).automatic, false);
  await checkForUpdates(home, { force: true, fetcher, now: now + 30000 }); assert.equal(calls, 3);
  assert.equal((await updateStatus(home)).automatic, false);
});

test('offline checks preserve the installed state and do not authorize stale automatic updates', async t => {
  const home = await temporary(t), now = Date.now();
  await checkForUpdates(home, { fetcher: async () => Response.json(policy()), now });
  const result = await checkForUpdates(home, { fetcher: async () => { throw new Error('offline'); }, now: now + 8 * 3600000 });
  assert.ok(result.error); assert.equal(result.currentVersion, RELEASE_VERSION);
  assert.ok(result.nextCheckAt < now + 10 * 3600000);
  await assert.rejects(applyUpdate(home, { automatic: true, fetcher: async () => { throw new Error('offline'); },
    handoff: () => assert.fail('Must not run an installer from stale policy') }), /offline/);
});

test('signed package downloads verify exact size and hash, reuse cache, and remove failed partial files', async t => {
  const home = await temporary(t), destination = join(home, 'package.bin'); let requests = 0;
  const item = { size: updateTestBytes.length, sha256: createHash('sha256').update(updateTestBytes).digest('hex') };
  const fetcher = async () => { requests++; return new Response(updateTestBytes); };
  await downloadVerifiedPackage('https://download.test/package', item, destination, { fetcher });
  assert.deepEqual(await readFile(destination), updateTestBytes);
  await downloadVerifiedPackage('https://download.test/package', item, destination, { fetcher }); assert.equal(requests, 1);
  for (const [suffix, bytes] of [['truncated', updateTestBytes.subarray(1)], ['oversized', Buffer.concat([updateTestBytes, Buffer.of(1)])],
    ['tampered', Buffer.alloc(updateTestBytes.length, 42)]]) {
    await assert.rejects(downloadVerifiedPackage('https://download.test/package', item, join(home, suffix), { fetcher: async () => new Response(bytes) }));
  }
  assert.deepEqual(await readdir(home), ['package.bin']);
});

test('verified upgrade handoff preserves binding, key, project and pause, and refuses duplicate installer execution', async t => {
  const home = await temporary(t), catalog = nextCatalog(), signed = await signUpdateFixture(catalog);
  const state = { schema: 1, deviceId: 'fixture-device', deviceSecret: 'a'.repeat(43), ownerToken: 'b'.repeat(43),
    keyId: 'fixture-key', bindingId: 'fixture-binding', accessKey: `tds_${'c'.repeat(43)}`,
    gateway: 'https://team.example.test', currentProjectRoot: home, remoteAccess: 'suspended',
    ports: { devspace: 47670, bridge: 47770, metrics: 47870 } };
  await atomicJson(join(home, 'state.json'), state);
  const before = await readFile(join(home, 'state.json'), 'utf8');
  let calls = 0;
  const fetcher = async url => url.endsWith('/v1/update-policy') ? Response.json(policy())
    : url.endsWith('/update.json') ? Response.json(signed) : new Response(updateTestBytes);
  const options = { fetcher, publicKey: updateTestPublicKey, distributionRoot: async () => home,
    handoff: async (file, version, actualHome, root) => {
      calls++; assert.equal(version, NEXT_VERSION); assert.equal(actualHome, home); assert.equal(root, home);
      assert.deepEqual(await readFile(file), updateTestBytes); return { handedOff: true };
    } };
  assert.equal((await applyUpdate(home, options)).handedOff, true);
  assert.equal(await readFile(join(home, 'state.json'), 'utf8'), before);
  if (process.platform !== 'darwin') await assert.rejects(applyUpdate(home, options), /安装器已启动/);
  assert.equal(calls, 1);
  const fresh = await temporary(t);
  await assert.rejects(applyUpdate(fresh, { ...options, signal: AbortSignal.abort() }), /aborted|Abort/);
  assert.equal(calls, 1);
});

test('installed versions never automatically downgrade or execute an unsigned upgrade', async t => {
  const home = await temporary(t);
  const noHandoff = () => assert.fail('An installer must not run');
  for (const stable of ['0.2.3', RELEASE_VERSION]) {
    const result = await applyUpdate(home, { fetcher: async () => Response.json(policy({ stable })), handoff: noHandoff });
    assert.equal(result.changed, false);
  }
  let calls = 0;
  await assert.rejects(applyUpdate(home, { fetcher: async () => Response.json(++calls === 1 ? policy() : nextCatalog()), handoff: noHandoff }), /Signed update metadata/);
});
