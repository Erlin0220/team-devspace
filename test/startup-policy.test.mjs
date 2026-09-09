import test from 'node:test';
import assert from 'node:assert/strict';
import { enabledStartupComponents, STARTUP_COMPONENTS } from '../client/platform.mjs';

test('startup install starts the normal platform components when remote access is active', () => {
  assert.deepEqual(enabledStartupComponents({ remoteAccess: 'active' }), STARTUP_COMPONENTS);
});

test('startup restoration keeps suspended remote access fail-closed', () => {
  const components = enabledStartupComponents({ remoteAccess: 'suspended' });
  assert.deepEqual(components, process.platform === 'win32' || process.platform === 'darwin' ? ['tray'] : []);
  assert.ok(!components.includes('runtime'));
  assert.ok(!components.includes('tunnel'));
});
