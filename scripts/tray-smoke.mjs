import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { desktopState } from '../client/desktop-state.mjs';

if (!['win32', 'darwin'].includes(process.platform)) {
  console.log(JSON.stringify({ skipped: true, reason: 'Native tray is a Windows/macOS component' }));
  process.exit(0);
}
const target = `${process.platform}-${process.arch}`;
const packaged = process.platform === 'win32'
  ? `build/bundle-${target}/platform/windows/team-devspace-tray.exe`
  : `build/bundle-${target}/platform/macos/Team DevSpace Tray.app/Contents/MacOS/TeamDevSpaceTray`;
const standalone = `build/team-devspace-tray${process.platform === 'win32' ? '.exe' : ''}`;
// Developer tray smoke defaults to the artifact produced by build:tray. Release
// acceptance passes the packaged path explicitly so a stale bundle can never be
// mistaken for the binary that was just compiled.
let binary = resolve(process.argv[2] ?? standalone);
try { await access(binary); }
catch (error) {
  if (process.argv[2]) throw error;
  binary = resolve(packaged);
  await access(binary);
}
const smokeHome = await mkdtemp(join(tmpdir(), 'team-devspace-ui-smoke-'));
const marker = join(smokeHome, '.ui-ready');
const env = { ...process.env, TEAM_DEVSPACE_TRAY_INSTANCE_ID: randomBytes(32).toString('hex'),
  TEAM_DEVSPACE_UI_READY_MARKER: marker };
const child = spawn(binary, ['--smoke'],
  { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let duplicate;
process.once('exit', () => {
  if (child.exitCode === null) child.kill();
  if (duplicate && duplicate.exitCode === null) duplicate.kill();
  rmSync(smokeHome, { recursive: true, force: true });
});
let stderr = '';
let trayVisible = false;
let protocolErrors = 0;
const applied = [];
const menuActions = [];
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
async function waitFor(predicate, description) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error(`Native UI did not ${description} while stdin remained open: ${stderr}`);
    }
    await delay(20);
  }
}
const ready = new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(new Error('Native tray did not become ready')), 10000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native tray exited before ready (${code}): ${stderr}`)); });
  createInterface({ input: child.stdout }).on('line', line => {
    const event = JSON.parse(line);
    if (event.event === 'protocol-error') protocolErrors++;
    if (event.event === 'tray-visible') trayVisible = true;
    if (event.event === 'state-applied') applied.push(event.status);
    if (event.event === 'menu') menuActions.push(event.action);
    if (event.event === 'ready') { clearTimeout(timer); resolveReady(); }
  });
});
await ready;
if (process.platform === 'darwin') {
  await waitFor(() => trayVisible, 'show the menu-bar item');
  await access(marker);
  assert.equal((await stat(marker)).mode & 0o777, 0o600);
}
duplicate = spawn(binary, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let duplicateStdout = '';
let duplicateStderr = '';
duplicate.stdout.on('data', chunk => { duplicateStdout += chunk; });
duplicate.stderr.on('data', chunk => { duplicateStderr += chunk; });
const duplicateCode = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => { duplicate.kill(); reject(new Error('Second native tray instance did not self-reject')); }, 10000);
  duplicate.once('error', reject);
  duplicate.once('exit', code => { clearTimeout(timer); resolveExit(code); });
});
assert.equal(duplicateCode, 0, duplicateStderr);
const duplicateEvents = duplicateStdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
assert.equal(duplicateEvents.some(event => event.event === 'ready'), false, 'A duplicate tray must never create a second icon');
assert.equal(duplicateEvents.some(event => event.event === 'duplicate'), true, 'A duplicate tray must report a clean single-instance rejection');
const healthy = { ready: true, devspace: true, bridge: true, tunnel: true, gateway: 'active',
  remoteAccess: 'active', desiredRemoteAccess: 'active', currentProjectRoot: '/smoke-project' };
const stopped = { ...healthy, ready: false, devspace: false, bridge: false, tunnel: false };
for (const state of [
  desktopState(healthy),
  desktopState({ ...healthy, ready: false, bridge: false }),
  desktopState({ ...stopped, gateway: 'suspended', remoteAccess: 'suspended', desiredRemoteAccess: 'suspended' }),
  desktopState(stopped),
  desktopState(healthy, { busy: true, activity: '正在检查连接…' }),
]) {
  const expected = applied.length + 1;
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
  if (process.platform === 'darwin') {
    // Split inside a UTF-8 character. One short JSON line must be consumed
    // without waiting for 4096 bytes, the next command, or EOF.
    const split = bytes.indexOf(Buffer.from('项目')) + 1;
    child.stdin.write(bytes.subarray(0, split));
    await delay(20);
    child.stdin.write(bytes.subarray(split));
    await waitFor(() => applied.length === expected, 'apply a short fragmented state message');
  } else child.stdin.write(bytes);
}
// Exercise the real native menu handlers on both platforms without invoking
// connection operations. Both adapters consume the production controller schema.
child.stdin.write(`${JSON.stringify(desktopState(healthy))}\n`);
for (const action of ['settings', 'remote', 'check', 'restart', 'repair', 'logs', 'diagnostics', 'about', 'exit']) {
  child.stdin.write(`${JSON.stringify({ exerciseMenu: action })}\n`);
}
child.stdin.write('not-json\n{}\n');
await waitFor(() => applied.length === 6 && menuActions.length === 9 && protocolErrors === 2,
  'process coalesced commands and malformed input');
if (process.platform === 'darwin') {
  await smokeMacForm(binary, env);
  const { stdout } = await promisify(execFile)(binary, ['choose-folder', '--smoke'], { env, timeout: 10000 });
  const selected = JSON.parse(stdout);
  assert.equal(selected.event, 'folder-result');
  assert.equal(selected.visible, true, 'The real AppKit directory picker must be visibly presented');
  assert.equal(selected.projectRoot, null, 'Cancelling the directory picker must not mutate settings');
  assert.equal(selected.canCreateDirectories, true, 'The real AppKit picker must allow native folder creation');
}
child.stdin.end();
const code = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('Native tray did not quit after protocol EOF')); }, 10000);
  child.once('close', code => { clearTimeout(timer); resolveExit(code); });
});
assert.equal(code, 0, stderr);
assert.equal(protocolErrors, 2, 'Native tray must accept valid state and explicitly reject malformed input');
assert.deepEqual(applied, ['ready', 'partial', 'suspended', 'stopped', 'ready', 'ready']);
assert.deepEqual(menuActions, ['settings', 'suspend', 'check', 'restart', 'repair', 'logs', 'troubleshoot', 'about', 'exit']);
console.log(JSON.stringify({ passed: true, platform: process.platform, nativeTray: true,
  protocol: 'json-lines', packagedArtifact: binary.includes(`bundle-${target}`), lifecycleIndependent: true,
  singleInstance: true, isolatedInstance: true, sharedMenu: true, nativeMenuActions: true, submenuActions: true,
  ...(process.platform === 'darwin' ? { appKitMenus: true, setupFormRetry: true, malformedInput: true,
    trayVisible: true, formVisible: true, directoryPicker: true, shortMessagesBeforeEOF: true, fragmentedUTF8: true } : {}) }));

async function smokeMacForm(binary, env) {
  const form = spawn(binary, ['form', '--smoke'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let duplicateForm;
  let timer;
  let submissions = 0;
  let visible = false;
  let stderr = '';
  const key = `tds_${'a'.repeat(43)}`;
  const send = value => form.stdin.write(`${JSON.stringify(value)}\n`);
  const done = new Promise((resolveDone, reject) => {
    timer = setTimeout(() => reject(new Error(`AppKit form smoke timed out before EOF: ${stderr}`)), 15000);
    form.once('error', reject);
    form.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    form.stdin.on('error', () => {});
    createInterface({ input: form.stdout }).on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'ready') {
          // A tray and a form coexist, but a second form must reject itself.
          duplicateForm = spawn(binary, ['form'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '';
          duplicateForm.stdout.on('data', data => { output += data; });
          duplicateForm.stderr.resume();
          duplicateForm.once('error', reject);
          duplicateForm.once('close', code => {
            try {
              assert.equal(code, 0);
              assert.equal(JSON.parse(output.trim()).event, 'duplicate');
              send({ type: 'form', mode: 'setup', projectRoot: '/tmp' });
            } catch (error) { reject(error); }
          });
        } else if (event.event === 'form-visible') {
          visible = true;
          send({ type: 'exercise-form', accessKey: key });
        } else if (event.event === 'submit') {
          assert.equal(event.accessKey, key);
          assert.equal(event.projectRoot, '/tmp');
          submissions++;
          send({ type: 'form-result', phase: 'busy', message: '正在验证…' });
          send({ type: 'form-result', phase: submissions === 1 ? 'error' : 'success',
            message: submissions === 1 ? '测试错误，可以重试。' : '设置已完成。' });
        } else if (event.event === 'form-updated') {
          assert.equal(event.inputEnabled, event.phase === 'error');
          if (event.phase === 'error') send({ type: 'exercise-form', accessKey: key });
          if (event.phase === 'success') send({ type: 'exercise-form', action: 'cancel' });
        } else if (event.event === 'cancel') form.stdin.end();
        else assert.notEqual(event.event, 'protocol-error');
      } catch (error) { reject(error); }
    });
    form.once('close', code => {
      try { assert.equal(code, 0, stderr); assert.equal(visible, true); assert.equal(submissions, 2); resolveDone(); }
      catch (error) { reject(error); }
    });
  });
  try { await done; }
  finally {
    clearTimeout(timer);
    if (form.exitCode === null) form.kill();
    if (duplicateForm?.exitCode === null) duplicateForm.kill();
  }
}
