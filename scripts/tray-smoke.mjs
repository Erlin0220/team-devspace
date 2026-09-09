import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

if (!['win32', 'darwin'].includes(process.platform)) {
  console.log(JSON.stringify({ skipped: true, reason: 'Native tray is a Windows/macOS component' }));
  process.exit(0);
}
const binary = resolve(process.argv[2] ?? `build/team-devspace-tray${process.platform === 'win32' ? '.exe' : ''}`);
await access(binary);
const child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const ready = new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(new Error('Native tray did not become ready')), 10000);
  createInterface({ input: child.stdout }).on('line', line => {
    const event = JSON.parse(line);
    if (event.event === 'ready') { clearTimeout(timer); resolveReady(); }
  });
});
await ready;
for (const state of [
  { status: 'ready', summary: '● Team DevSpace 正常', remoteAccess: 'active', busy: false },
  { status: 'partial', summary: '● Team DevSpace 部分异常', remoteAccess: 'active', busy: false },
  { status: 'suspended', summary: '● Team DevSpace 远程访问已暂停', remoteAccess: 'suspended', busy: false },
  { status: 'stopped', summary: '○ Team DevSpace 已停止', remoteAccess: 'active', busy: false },
]) child.stdin.write(`${JSON.stringify(state)}\n`);
child.stdin.end();
const code = await new Promise((resolveExit, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('Native tray did not quit after protocol EOF')); }, 10000);
  child.once('exit', code => { clearTimeout(timer); resolveExit(code); });
});
assert.equal(code, 0, stderr);
console.log(JSON.stringify({ passed: true, platform: process.platform, nativeTray: true,
  protocol: 'json-lines', lifecycleIndependent: true }));
