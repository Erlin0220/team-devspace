import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxServiceManager } from '../client/linux-lifecycle.mjs';
import { isSameProcess, processIdentity, standaloneDirectory } from '../client/standalone.mjs';

const fails = code => async () => { throw Object.assign(new Error('fixture'), { code }); };

test('Linux chooses standalone only for actual absence, never a broken user manager or hidden systemctl', async () => {
  assert.equal(await linuxServiceManager({ run: async () => ({ stdout: '' }) }), 'systemd-user');
  assert.equal(await linuxServiceManager({ run: fails('ENOENT'), exists: async () => false }), 'standalone');
  for (const code of ['EACCES', 1, 'ETIMEDOUT']) {
    await assert.rejects(linuxServiceManager({ run: fails(code), exists: async () => false }), { code: 'linux_user_manager_unavailable' });
  }
  await assert.rejects(linuxServiceManager({ run: fails('ENOENT'), exists: async () => true }), { code: 'linux_user_manager_unavailable' });
});

test('Linux process ownership includes birth time, boot and PID namespace, not just a live PID', { skip: process.platform !== 'linux' }, async () => {
  const identity = await processIdentity(process.pid);
  assert.ok(await isSameProcess(identity));
  assert.equal(await isSameProcess({ ...identity, start: '0' }), false);
  assert.equal(await isSameProcess({ ...identity, boot: 'old-boot' }), false);
  assert.equal(await isSameProcess({ ...identity, namespace: 'old-namespace' }), false);
  assert.equal(await isSameProcess({ ...identity, pid: -1 }), false);
  assert.equal(await processIdentity(0), null);
});

test('standalone ownership canonicalizes home and is stable across shells, but rejects runtime symlinks',
  { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'tds-owner-test-'));
    const alias = `${home}-alias`;
    t.after(async () => { await rm(alias, { force: true }); await rm(home, { recursive: true, force: true }); });
    await symlink(home, alias);
    const directory = await standaloneDirectory(home);
    t.after(() => rm(directory, { recursive: true, force: true }));
    assert.equal(await standaloneDirectory(alias), directory);
    const previous = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.XDG_RUNTIME_DIR = '/unrelated-shell-runtime';
      assert.equal(await standaloneDirectory(home), directory);
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous;
    }
    await rm(directory, { recursive: true });
    await symlink(home, directory);
    await assert.rejects(standaloneDirectory(home), /Unsafe standalone runtime directory/);
  });
