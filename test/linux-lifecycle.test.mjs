import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxServiceManager } from '../client/linux-lifecycle.mjs';
import { linuxJournalInvocation, systemdUserUnit } from '../client/platform.mjs';
import { isSameProcess, processIdentity, standaloneDirectory } from '../client/standalone.mjs';

const fails = code => async () => { throw Object.assign(new Error('fixture'), { code }); };

test('Linux diagnostics use only the current invocation owned by the requested state home', async () => {
  const home = '/tmp/team devspace "owned" % home';
  const invocation = 'a'.repeat(32);
  const unit = systemdUserUnit({ ports: { metrics: 47870 } }, 'runtime', home, {}, '/opt/tds/versions/1');
  let metadata = `FragmentPath=/fixture/runtime.service\nInvocationID=${invocation}\n`;
  let reads = 0;
  const options = {
    run: async (command, args) => {
      assert.equal(command, 'systemctl');
      assert.ok(args.includes('team-devspace-runtime.service'));
      return { stdout: metadata };
    },
    read: async path => { assert.equal(path, '/fixture/runtime.service'); reads++; return unit; },
  };
  assert.equal(await linuxJournalInvocation(home, 'runtime', options), invocation);
  assert.equal(await linuxJournalInvocation(`${home}/different-device`, 'runtime', options), null);
  assert.equal(await linuxJournalInvocation(home, 'tray', options), null);
  for (const missing of ['', '0'.repeat(32), 'malformed']) {
    metadata = `FragmentPath=/fixture/runtime.service\nInvocationID=${missing}\n`;
    assert.equal(await linuxJournalInvocation(home, 'runtime', options), null);
  }
  assert.equal(reads, 2, 'Missing invocation metadata must not read an unrelated journal');
});

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
