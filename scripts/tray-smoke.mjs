import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

if (!['win32', 'darwin'].includes(process.platform)) {
  console.log(JSON.stringify({ skipped: true, reason: 'Native tray is a Windows/macOS component' }));
  process.exit(0);
}
const target = `${process.platform}-${process.arch}`;
const packaged = process.platform === 'win32'
  ? `build/bundle-${target}/platform/windows/team-devspace-tray.exe`
  : `build/bundle-${target}/platform/macos/Team DevSpace Tray.app/Contents/MacOS/TeamDevSpaceTray`;
const standalone = `build/team-devspace-tray${process.platform === 'win32' ? '.exe' : ''}`;
let binary = resolve(process.argv[2] ?? packaged);
try { await access(binary); }
catch (error) {
  if (process.argv[2]) throw error;
  binary = resolve(standalone);
  await access(binary);
}
const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
let protocolErrors = 0;
child.stderr.on('data', chunk => { stderr += chunk; });
const ready = new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(new Error('Native tray did not become ready')), 10000);
  createInterface({ input: child.stdout }).on('line', line => {
    const event = JSON.parse(line);
    if (event.event === 'protocol-error') protocolErrors++;
    if (event.event === 'ready') { clearTimeout(timer); resolveReady(); }
  });
});
await ready;
for (const state of [
  { status: 'ready', summary: '● Team DevSpace 正常', remoteText: '暂停远程访问', remoteAction: 'suspend',
    remoteEnabled: true, checkEnabled: true, restartEnabled: true, repairEnabled: true, exitEnabled: true },
  { status: 'partial', summary: '● Team DevSpace 部分异常', remoteText: '暂停远程访问', remoteAction: 'suspend',
    remoteEnabled: true, checkEnabled: true, restartEnabled: true, repairEnabled: true, exitEnabled: true },
  { status: 'suspended', summary: '● Team DevSpace 远程访问已暂停', remoteText: '恢复远程访问', remoteAction: 'resume',
    remoteEnabled: true, checkEnabled: true, restartEnabled: false, repairEnabled: false, exitEnabled: true },
  { status: 'stopped', summary: '○ Team DevSpace 已停止', remoteText: '暂停远程访问', remoteAction: 'suspend',
    remoteEnabled: true, checkEnabled: true, restartEnabled: true, repairEnabled: true, exitEnabled: true },
]) child.stdin.write(`${JSON.stringify(state)}\n`);
child.stdin.end();
const code = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('Native tray did not quit after protocol EOF')); }, 10000);
  child.once('exit', code => { clearTimeout(timer); resolveExit(code); });
});
assert.equal(code, 0, stderr);
assert.equal(protocolErrors, 0, 'Native tray rejected one or more smoke-test state messages');
console.log(JSON.stringify({ passed: true, platform: process.platform, nativeTray: true,
  protocol: 'json-lines', packagedArtifact: binary.includes(`bundle-${target}`), lifecycleIndependent: true }));
