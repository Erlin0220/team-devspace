import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { closeService } from '../client/runtime.mjs';
import * as standalone from '../client/standalone.mjs';
test('runtime cleanup waits for HTTP teardown if application cleanup rejects', async t => {
  const server = createServer((_request, response) => { response.writeHead(200); response.write('open'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = request({ host: '127.0.0.1', port: server.address().port, path: '/' });
  client.on('error', () => {}); client.end();
  const [response] = await once(client, 'response'); response.on('error', () => {}); response.resume();
  let httpClosed = false; server.once('close', () => { httpClosed = true; });
  t.after(() => { client.destroy(); server.closeAllConnections(); server.close(); });
  await assert.rejects(closeService({ server, close: async () => { throw new Error('application close failed'); } }), /application close failed/);
  assert.equal(httpClosed, true, 'Application cleanup failure must not cancel HTTP force-close or leave an occupied port');
});
test('standalone log failures are bounded, retryable and never stop the worker', async () => {
  assert.equal(typeof standalone.logWriter, 'function');
  let now = 0, opens = 0, writes = 0, closed = 0, failWrite = true;
  const writer = await standalone.logWriter('test-only', { now: () => now, retryDelayMs: 100,
    openFile: async () => {
      if (++opens === 1) throw new Error('log unavailable');
      return { stat: async () => ({ size: 0 }), write: async () => { if (failWrite) throw new Error('disk full'); writes++; },
        truncate: async () => {}, close: async () => { closed++; } };
    } });
  await writer.write('dropped'); await writer.write('dropped too');
  assert.equal(opens, 1, 'Do not retry disk I/O for every chunk during an outage');
  now = 101; await writer.write('write failure');
  failWrite = false; now = 202; await writer.write('recovered'); await writer.close();
  assert.equal(writes, 1); assert.equal(opens, 3); assert.equal(closed, 2);
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAC_DIAGNOSTIC_LAUNCH, serviceAction } from '../client/platform.mjs';
test('ordinary desktop reopening may degrade a tray start failure but never a core start failure',
  { skip: !['win32', 'darwin'].includes(process.platform) }, async () => {
  const state = { ownerToken: 'a'.repeat(43), deviceId: randomUUID(), ports: { devspace: 0, bridge: 0, metrics: 0 } };
  const calls = [];
  const runNative = async (_command, args) => {
    calls.push(args.join(' '));
    if (args.join(' ').includes('.tray')) throw new Error('tray unavailable');
    return { stdout: 'existing job' };
  };
  const result = await serviceAction('start', state, 'unused', ['runtime', 'tunnel', 'tray'], {
    runNative, allowTrayFailure: true, repairTray: async () => { throw new Error('tray repair unavailable'); },
  });
  assert.match(result.warning, /托盘/);
  assert.ok(calls.some(call => call.includes('.runtime')) && calls.some(call => call.includes('.tunnel')));
  assert.ok(calls.every(call => !/bootout|\/End|\/Delete/.test(call)), 'Reopening must not stop or reinstall healthy jobs');
  await assert.rejects(serviceAction('start', state, 'unused', ['tray'], { runNative }), /tray unavailable/,
    'Installer activation remains strict by default');
  await assert.rejects(serviceAction('start', state, 'unused', ['runtime', 'tray'], {
    allowTrayFailure: true, runNative: async () => { throw new Error('core unavailable'); },
  }), /core unavailable/);
});

test('ordinary reopening repairs only a missing tray entry and retries without restarting healthy core jobs',
  { skip: !['win32', 'darwin'].includes(process.platform) }, async () => {
  const state = { ownerToken: 'a'.repeat(43), deviceId: randomUUID(), ports: { devspace: 0, bridge: 0, metrics: 0 } };
  const calls = []; let repaired = false;
  const result = await serviceAction('start', state, 'unused', ['runtime', 'tunnel', 'tray'], {
    allowTrayFailure: true,
    runNative: async (_command, args) => {
      calls.push(args.join(' '));
      if (args.join(' ').includes('.tray') && !repaired) throw new Error('tray entry missing');
      return { stdout: 'existing job' };
    },
    repairTray: async () => { assert.equal(repaired, false, 'Repair must be attempted only once'); repaired = true; },
  });
  assert.equal(repaired, true);
  assert.equal(result?.warning, undefined);
  assert.ok(calls.every(call => !/bootout|\/End|\/Delete/.test(call)));
  const starts = calls.filter(call => /\/Run|kickstart/.test(call));
  assert.equal(starts.filter(call => call.includes('.runtime')).length, 1);
  assert.equal(starts.filter(call => call.includes('.tunnel')).length, 1);
  const source = await readFile(new URL('../client/platform.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("repairTray = () => installServices(state, home, undefined, ['tray'])"),
    'Production repair must remain scoped to the tray, never the default whole service set');
});
test('macOS diagnostics wrapper falls back before exec but never reruns a failed worker', async t => {
  const work = await mkdtemp(join(tmpdir(), 'tds-mac-log-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  for (const blocked of [false, true]) {
    const cwd = join(work, String(blocked)); await mkdir(cwd);
    await assert.rejects(promisify(execFile)('bash', ['-c', MAC_DIAGNOSTIC_LAUNCH, 'test-launch',
      '/bin/sh', '-c', "printf 'run\n' >> proof; printf out; printf err >&2; exit 7"], {
      cwd, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '',
        TEAM_DEVSPACE_STDOUT: blocked ? '.' : 'stdout.log', TEAM_DEVSPACE_STDERR: blocked ? '.' : 'stderr.log' },
    }), error => error.code === 7);
    assert.equal(await readFile(join(cwd, 'proof'), 'utf8'), 'run\n');
    if (!blocked) {
      assert.equal(await readFile(join(cwd, 'stdout.log'), 'utf8'), 'out');
      assert.equal(await readFile(join(cwd, 'stderr.log'), 'utf8'), 'err');
    }
  }
});
test('one failed Windows component stop cannot skip the other owners or begin a replacement',
  { skip: process.platform !== 'win32' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-stop-isolation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const state = { ownerToken: 'a'.repeat(43), deviceId: randomUUID(), ports: { devspace: 0, bridge: 0, metrics: 0 } };
  for (const action of ['stop', 'restart']) {
    const stopped = []; let starts = 0;
    await assert.rejects(serviceAction(action, state, home, ['runtime', 'tunnel', 'tray'], {
      runNative: async (_command, args) => {
        if (args.includes('/Run')) starts++;
        if (args.includes('/End')) {
          const label = args[args.indexOf('/TN') + 1]; stopped.push(label.split('.').at(-1));
          if (label.endsWith('.tray')) throw new Error('tray task failure');
        }
        return { stdout: '<Task />' };
      },
    }), AggregateError);
    assert.ok(stopped.includes('tray')); assert.ok(stopped.includes('tunnel')); assert.ok(stopped.includes('runtime'));
    assert.equal(starts, 0, 'A partial stop never authorizes replacement or overlapping process owners');
  }
});
test('bad standalone ownership metadata cannot prevent cleanup of another independent component',
  { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-standalone-cleanup-'));
  let directory;
  t.after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  const state = { remoteAccess: 'active' };
  await standalone.installStandalone(state, home, process.cwd(), ['runtime', 'tunnel']);
  directory = await standalone.standaloneDirectory(home);
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ home: 'foreign-home', component: 'runtime', nonce: 'bad-owner' }));
  await assert.rejects(standalone.standaloneAction('remove', state, home, ['runtime', 'tunnel']), AggregateError);
  assert.ok(await readFile(join(home, 'startup/runtime.standalone.json'), 'utf8'));
  await assert.rejects(readFile(join(home, 'startup/tunnel.standalone.json')), { code: 'ENOENT' });
  assert.ok(await readFile(join(directory, 'runtime.json'), 'utf8'), 'Untrusted ownership is retained, never signalled or silently removed');
});
