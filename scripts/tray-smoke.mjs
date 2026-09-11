import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

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
const env = { ...process.env, TEAM_DEVSPACE_TRAY_INSTANCE_ID: randomBytes(32).toString('hex') };
const child = spawn(binary, [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let duplicate;
process.once('exit', () => {
  if (child.exitCode === null) child.kill();
  if (duplicate && duplicate.exitCode === null) duplicate.kill();
});
let stderr = '';
let protocolErrors = 0;
child.stderr.on('data', chunk => { stderr += chunk; });
const ready = new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(new Error('Native tray did not become ready')), 10000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native tray exited before ready (${code}): ${stderr}`)); });
  createInterface({ input: child.stdout }).on('line', line => {
    const event = JSON.parse(line);
    if (event.event === 'protocol-error') protocolErrors++;
    if (event.event === 'ready') { clearTimeout(timer); resolveReady(); }
  });
});
await ready;
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
const common = {
  checkEnabled: true, switchKeyText: '更换 Access Key…', switchKeyEnabled: true,
  logsEnabled: true, diagnosticsEnabled: true, diagnosticsText: '复制诊断信息', exitEnabled: true,
};
for (const state of [
  { ...common, status: 'ready', summary: 'Team DevSpace 正常', remoteText: '暂停远程访问', remoteAction: 'suspend',
    remoteEnabled: true, restartEnabled: true, repairEnabled: true },
  { ...common, status: 'partial', summary: 'Team DevSpace 部分异常', remoteText: '暂停远程访问', remoteAction: 'suspend',
    remoteEnabled: true, restartEnabled: true, repairEnabled: true },
  { ...common, status: 'suspended', summary: 'Team DevSpace 远程访问已暂停', remoteText: '恢复远程访问', remoteAction: 'resume',
    remoteEnabled: true, restartEnabled: false, repairEnabled: false },
  { ...common, status: 'stopped', summary: 'Team DevSpace 本机服务已停止', remoteText: '暂停远程访问', remoteAction: 'suspend',
    remoteEnabled: true, restartEnabled: true, repairEnabled: true },
  { ...common, status: 'ready', summary: 'Team DevSpace 正常', activity: '正在检查连接…', remoteText: '暂停远程访问',
    remoteAction: 'suspend', remoteEnabled: false, checkEnabled: false, switchKeyEnabled: false,
    restartEnabled: false, repairEnabled: false, exitEnabled: false },
]) child.stdin.write(`${JSON.stringify(state)}\n`);
child.stdin.end();
const code = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('Native tray did not quit after protocol EOF')); }, 10000);
  child.once('exit', code => { clearTimeout(timer); resolveExit(code); });
});
assert.equal(code, 0, stderr);
assert.equal(protocolErrors, 0, 'Native tray rejected one or more smoke-test state messages');
console.log(JSON.stringify({ passed: true, platform: process.platform, nativeTray: true,
  protocol: 'json-lines', packagedArtifact: binary.includes(`bundle-${target}`), lifecycleIndependent: true,
  singleInstance: true, isolatedInstance: true }));
