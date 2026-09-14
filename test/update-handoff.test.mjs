import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildWindowsLauncher } from '../scripts/windows-launcher.mjs';
import { runWindowsDesktop } from '../client/windows-desktop.mjs';

const exec = promisify(execFile);
async function waitFor(read, predicate, description) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (predicate(value)) return value; } catch {}
    await sleep(200);
  }
  throw new Error(description);
}
const updaterModule = pathToFileURL(resolve('client/updates.mjs')).href;

// These are real OS handoffs using harmless synthetic installers, not evidence
// that the retail EXE/PKG/TAR has passed its separate platform acceptance.
test('Windows update survives the initiating Job Object and its one-shot task removes itself',
  { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'tds update handoff '));
    const directory = join(home, 'updates'); await mkdir(directory);
    t.after(async () => {
      const request = JSON.parse(await readFile(join(directory, 'install-request.json'), 'utf8').catch(() => '{}'));
      if (request.taskName) await runWindowsDesktop(`
Stop-ScheduledTask -TaskName $env:TDS_TEST_TASK -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $env:TDS_TEST_TASK -Confirm:$false -ErrorAction SilentlyContinue
`, { env: { TDS_TEST_TASK: request.taskName } }).catch(() => {});
      await rm(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    });
    const launcher = await buildWindowsLauncher(join(home, 'tds-launcher.exe'));
    const installer = await buildWindowsLauncher(join(home, 'fixture-installer.exe'), resolve('test/fixtures/update-installer.c'));
    const root = join(home, 'Install Root');
    const code = `import { handoffInstaller } from ${JSON.stringify(updaterModule)};
      await handoffInstaller(${JSON.stringify(installer)}, '0.2.5', ${JSON.stringify(home)}, ${JSON.stringify(root)}, { launcher: ${JSON.stringify(launcher)} });`;
    const result = await exec(launcher, ['--cwd', home, '--stdout', join(home, 'parent.log'), '--stderr', join(home, 'parent.error.log'),
      '--env', 'NODE_OPTIONS=', '--', process.execPath, '--input-type=module', '-e', code], { windowsHide: true, timeout: 60000 }).catch(async error => {
        throw new Error(`${error.message}\n${await readFile(join(home, 'parent.error.log'), 'utf8').catch(() => '')}`);
      });
    assert.equal(result.stderr, '');
    const completed = await waitFor(async () => JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')),
      value => Number.isInteger(value.exitCode), 'The one-shot update task did not finish after its parent exited');
    assert.equal(completed.exitCode, 0, JSON.stringify(completed));
    assert.match(completed.attemptId, /^[a-f0-9-]{36}$/);
    const proof = await readFile(join(home, 'installer-proof.txt'), 'utf8');
    assert.ok(proof.endsWith(`/S /D=${root}`), proof);
    const request = JSON.parse(await readFile(join(directory, 'install-request.json'), 'utf8'));
    assert.equal(completed.attemptId, request.attemptId);
    await waitFor(() => runWindowsDesktop(`if (-not (Get-ScheduledTask -TaskName $env:TDS_TEST_TASK -ErrorAction SilentlyContinue)) { 'absent' }`,
      { env: { TDS_TEST_TASK: request.taskName } }), value => value.trim() === 'absent', 'Completed task was not removed');
  });

test('Linux update reuses bootstrap in an independent installer process and cleans staging',
  { skip: process.platform !== 'linux', timeout: 60000 }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'tds-update-handoff-linux-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const directory = join(home, 'updates'), media = join(home, 'media');
    await mkdir(directory); await mkdir(media);
    await writeFile(join(media, 'install.sh'), '#!/bin/sh\nset -eu\nsleep 3\nprintf "%s\\n" "$*" > "$TEAM_DEVSPACE_HOME/installer-proof.txt"\n');
    const archive = join(home, 'package.tar.gz'); await exec('tar', ['-czf', archive, '-C', media, '.']);
    const root = join(home, 'distribution');
    const code = `import { handoffInstaller } from ${JSON.stringify(updaterModule)};
      await handoffInstaller(${JSON.stringify(archive)}, '0.2.5', ${JSON.stringify(home)}, ${JSON.stringify(root)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    let error = ''; child.stderr.on('data', data => { error += data; });
    await new Promise((resolveRun, reject) => { child.once('error', reject); child.once('exit', code_ => code_ === 0 ? resolveRun() : reject(new Error(error))); });
    const completed = await waitFor(async () => JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')),
      value => Number.isInteger(value.exitCode), 'Detached Linux installer did not report completion');
    assert.equal(completed.exitCode, 0);
    assert.match(completed.attemptId, /^[a-f0-9-]{36}$/);
    const proof = await readFile(join(home, 'installer-proof.txt'), 'utf8');
    assert.ok(proof.includes(`--root ${root} --setup none`));
  });
