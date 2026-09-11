import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile('platform/unix/bootstrap.sh', 'utf8');

test('Unix distribution root is explicitly owned and uninstall removes only Team DevSpace paths', () => {
  assert.match(script, /OWNER_MARKER=.*\.team-devspace-distribution/);
  assert.match(script, /assert_distribution_root/);
  assert.match(script, /remove_distribution_payload/);
  assert.doesNotMatch(script, /rm -rf "\$ROOT"/,
    'Uninstall must never recursively delete an arbitrary caller-selected distribution root');
});

test('Unix installer reclaims only a stale lock whose recorded PID is no longer alive', () => {
  assert.match(script, /kill -0 "\$owner_pid"/);
  assert.match(script, /Reclaiming stale installer lock/);
  assert.match(script, /missing or invalid owner PID/,
    'A lock without trustworthy ownership metadata must remain fail-closed');
});

test('Unix damaged-client uninstall has a native startup fallback', () => {
  assert.match(script, /remove_native_startup_fallback/);
  assert.match(script, /invoke_client "\$current" uninstall/);
  assert.match(script, /Installed client uninstall failed; using native startup cleanup fallback/);
  assert.match(script, /team-devspace-runtime\.service/);
  assert.ok(script.includes('label="com.teamdevspace.$component"'));
});
