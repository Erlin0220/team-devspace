import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireProcessLock, processLockHeld } from '../client/process-lock.mjs';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tds-process-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('process lock exposes one crash-safe owner at a time', async t => {
  const directory = await temporary(t), path = join(directory, 'owner.sqlite');
  const release = await acquireProcessLock(path);
  assert.equal(await processLockHeld(path), true);
  await assert.rejects(acquireProcessLock(path), { code: 'process_lock_busy' });
  await release();
  assert.equal(await processLockHeld(path), false);
});

test('process exit releases ownership without a stale timeout', async t => {
  const directory = await temporary(t), path = join(directory, 'crash.sqlite');
  const moduleUrl = pathToFileURL(resolve('client/process-lock.mjs')).href;
  const script = `import { acquireProcessLock } from ${JSON.stringify(moduleUrl)};\n` +
    `await acquireProcessLock(${JSON.stringify(path)});\n` +
    `process.stdout.write('locked\\n');\n` +
    `setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [chunk] = await once(child.stdout, 'data');
  assert.match(chunk.toString(), /locked/);
  assert.equal(await processLockHeld(path), true);
  child.kill();
  await once(child, 'exit');
  const release = await acquireProcessLock(path);
  await release();
  assert.equal(await processLockHeld(path), false);
});
