import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildWindowsLauncher, peDetails, WINDOWS_GUI_SUBSYSTEM, WINDOWS_X64_MACHINE } from '../scripts/windows-launcher.mjs';

const windowsOnly = { skip: process.platform !== 'win32' };

function run(file, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveRun({ code, signal }));
  });
}

async function waitFor(read, accept, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch {}
    await sleep(50);
  }
  throw new Error(message);
}

test('Windows launcher is GUI-subsystem, preserves arguments/environment/logs and returns the child exit code', windowsOnly, async t => {
  const work = await mkdtemp(join(tmpdir(), 'tds launcher '));
  t.after(() => rm(work, { recursive: true, force: true }));
  const launcher = await buildWindowsLauncher(join(work, 'tds-launcher.exe'));
  assert.deepEqual(await peDetails(launcher), {
    machine: WINDOWS_X64_MACHINE, subsystem: WINDOWS_GUI_SUBSYSTEM, clrHeaderSize: 0,
  });
  const stdout = join(work, 'logs', 'out.log');
  const stderr = join(work, 'logs', 'error.log');
  const script = "process.stdout.write(process.env.TDS_LAUNCHER_TEST+'|'+process.argv.at(-1));process.stderr.write('stderr-proof');process.exit(7)";
  const result = await run(launcher, ['--cwd', work, '--stdout', stdout, '--stderr', stderr,
    '--env', 'TDS_LAUNCHER_TEST=environment value', '--', process.execPath, '-e', script, '--', 'argument with spaces']);
  assert.deepEqual(result, { code: 7, signal: null });
  assert.equal(await readFile(stdout, 'utf8'), 'environment value|argument with spaces');
  assert.equal(await readFile(stderr, 'utf8'), 'stderr-proof');
});

test('closing the Windows launcher job terminates its child process tree', windowsOnly, async t => {
  const work = await mkdtemp(join(tmpdir(), 'tds launcher job '));
  t.after(() => rm(work, { recursive: true, force: true }));
  const launcher = await buildWindowsLauncher(join(work, 'tds-launcher.exe'));
  const stdout = join(work, 'child.log');
  const stderr = join(work, 'child.error.log');
  const child = spawn(launcher, ['--cwd', work, '--stdout', stdout, '--stderr', stderr, '--', process.execPath,
    '-e', "process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)"], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const pid = Number((await waitFor(() => readFile(stdout, 'utf8'), value => /^\d+\r?\n$/.test(value),
    'Launcher child did not start')).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  child.kill();
  await waitFor(() => new Promise(resolveProcess => {
    try { process.kill(pid, 0); resolveProcess(false); } catch (error) { resolveProcess(error.code === 'ESRCH'); }
  }), value => value, 'Launcher job did not terminate its child');
});
