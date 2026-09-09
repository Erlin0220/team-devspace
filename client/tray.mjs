import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { copyDiagnosticReport, openLogs, restartTeamDevSpace, resumeRemoteAccess,
  suspendRemoteAccess } from './control.mjs';
import { deviceStatus } from './setup.mjs';
import { installRoot, stateHome } from './state.mjs';

export function trayExecutable(root = installRoot) {
  if (process.platform === 'win32') return join(root, 'platform', 'windows', 'team-devspace-tray.exe');
  if (process.platform === 'darwin') return join(root, 'platform', 'macos', 'Team DevSpace Tray.app',
    'Contents', 'MacOS', 'TeamDevSpaceTray');
  throw new Error('The native tray is available on Windows and macOS; use the CLI on Linux');
}

export function trayState(status, { busy = false, notice } = {}) {
  if (!status) return { status: 'stopped', summary: '○ Team DevSpace 未完成 Enrollment',
    remoteAccess: 'not-enrolled', busy, ...(notice ? { notice } : {}) };
  const stopped = !status.devspace && !status.bridge && !status.tunnel;
  const visual = status.remoteAccess === 'suspended' ? 'suspended'
    : status.ready ? 'ready' : stopped ? 'stopped' : 'partial';
  const summary = ({ ready: '● Team DevSpace 正常', partial: '● Team DevSpace 部分异常',
    suspended: '● Team DevSpace 远程访问已暂停', stopped: '○ Team DevSpace 已停止' })[visual];
  return { status: visual, summary, remoteAccess: status.remoteAccess, busy, ...(notice ? { notice } : {}) };
}

export async function runTray(home = stateHome(), options = {}) {
  const helper = options.helper ?? trayExecutable(options.root);
  const operations = options.operations ?? {
    status: () => deviceStatus(home),
    suspend: () => suspendRemoteAccess(home),
    resume: () => resumeRemoteAccess(home),
    restart: () => restartTeamDevSpace(home),
    logs: () => openLogs(home),
    diagnostics: () => copyDiagnosticReport(home),
  };
  const child = spawn(helper, options.helperArgs ?? [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let helperClosed = false;
  child.stdin.on('error', () => {});
  child.once('exit', () => { helperClosed = true; });
  const send = state => {
    if (!helperClosed && child.stdin.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(state)}\n`);
  };
  const inspect = async (extra = {}) => {
    try { const status = await operations.status(); send(trayState(status, extra)); return status; }
    catch { send(trayState(null, extra)); return null; }
  };
  let work = Promise.resolve();
  const act = action => {
    work = work.then(async () => {
      if (action === 'check') return inspect();
      await inspect({ busy: true, notice: '正在执行操作…' });
      try {
        const result = await operations[action]();
        return inspect({ notice: action === 'diagnostics' ? '诊断信息已复制' : '操作已完成' }) ?? result;
      } catch (error) {
        return inspect({ notice: `操作失败：${String(error.message).slice(0, 160)}` });
      }
    });
  };
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.event === 'ready') void act('check');
      else if (event.event === 'menu' && ['check', 'suspend', 'resume', 'restart', 'logs', 'diagnostics'].includes(event.action)) void act(event.action);
    } catch {}
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const interval = setInterval(() => void act('check'), options.refreshInterval ?? 15000);
  interval.unref();
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(interval);
  await work;
  if (exit.signal || exit.code !== 0) throw new Error(`Native tray exited unexpectedly (${exit.signal ?? exit.code})`);
}
