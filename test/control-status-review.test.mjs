import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, readJson, RELEASE_VERSION } from '../client/state.mjs';
import { updateStatus } from '../client/updates.mjs';
import { startLocalControl } from '../client/local-control.mjs';

async function temporary(t) {
  const home = await mkdtemp(join(tmpdir(), 'tds-control-review-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('status polling cannot turn a starting same-version repair into installer success', async t => {
  const home = await temporary(t);
  const attempt = { version: RELEASE_VERSION, startedAt: Date.now(), attemptId: 'same-version-repair', phase: 'starting' };
  await atomicJson(join(home, 'updates/attempt.json'), attempt);
  const state = await updateStatus(home);
  assert.deepEqual(await readJson(join(home, 'updates/attempt.json'), null), attempt, 'A status read must not remove the guard of an in-flight repair');
  assert.equal(await readJson(join(home, 'updates/result.json'), null), null, 'Running the old same-version process is not a successful installer exit');
  assert.notEqual(state.installation?.status, 'installed');
});

test('an expired macOS authorization attempt is not projected as installing forever', async t => {
  const home = await temporary(t);
  const parts = RELEASE_VERSION.split('.').map(Number); parts[2]++;
  await atomicJson(join(home, 'updates/attempt.json'), { version: parts.join('.'),
    startedAt: Date.now() - 2 * 60 * 60 * 1000, attemptId: 'cancelled-native-window', phase: 'awaiting-authorization' });
  const state = await updateStatus(home);
  assert.ok(!['awaiting-authorization', 'installing', 'waiting-restart'].includes(state.installation?.status),
    'An expired attempt must become an actionable, retryable outcome rather than permanent busy feedback');
});

test('an invalid retained local capability fails clearly instead of silently replacing browser identity', async t => {
  const home = await temporary(t);
  const invalid = { schema: 1, token: 'corrupted-capability' };
  await atomicJson(join(home, 'control-capability.json'), invalid);
  let ui;
  try {
    await assert.rejects(async () => {
      ui = await startLocalControl({ snapshot: () => ({}) }, { home, port: 0, openBrowser: async () => {} });
    }, /capability|凭据|控制中心/i);
    assert.deepEqual(await readJson(join(home, 'control-capability.json')), invalid);
  } finally { await ui?.close(); }
});

test('a successful installer exit without a matching new runtime has a bounded restart wait', async t => {
  const home = await temporary(t);
  const parts = RELEASE_VERSION.split('.').map(Number); parts[2]++;
  const version = parts.join('.'), attemptId = 'installer-finished-runtime-missing';
  await atomicJson(join(home, 'updates/attempt.json'), { version, sourceVersion: RELEASE_VERSION,
    startedAt: Date.now() - 2 * 60 * 60 * 1000, attemptId, phase: 'installing' });
  await atomicJson(join(home, 'updates/result.json'), { version, attemptId, exitCode: 0 });
  const state = await updateStatus(home);
  assert.equal(state.installation.status, 'expired');
  assert.equal((await readJson(join(home, 'updates/result.json'))).exitCode, 0, 'The status reader must not rewrite installer evidence');
});

test('a different source version proves new runtime startup even when the old process ended during handoff', async t => {
  const home = await temporary(t);
  const attempt = { version: RELEASE_VERSION, sourceVersion: '0.0.1',
    startedAt: Date.now(), attemptId: 'handoff-ended-old-process', phase: 'starting' };
  await atomicJson(join(home, 'updates/attempt.json'), attempt);
  const state = await updateStatus(home);
  assert.equal(state.installation.status, 'installed');
  assert.deepEqual(await readJson(join(home, 'updates/attempt.json')), attempt);
  assert.equal(await readJson(join(home, 'updates/result.json'), null), null);
});
