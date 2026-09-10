import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { copyDiagnosticReport, openLogs, restartTeamDevSpace, resumeRemoteAccess,
  stopTeamDevSpace, suspendRemoteAccess } from './control.mjs';
import { deviceStatus, repairDevice } from './setup.mjs';
import { installRoot, stateHome } from './state.mjs';

export function trayExecutable(root = installRoot) {
  if (process.platform === 'win32') return join(root, 'platform', 'windows', 'team-devspace-tray.exe');
  if (process.platform === 'darwin') return join(root, 'platform', 'macos', 'Team DevSpace Tray.app',
    'Contents', 'MacOS', 'TeamDevSpaceTray');
  throw new Error('The native tray is available on Windows and macOS; use the CLI on Linux');
}

export function trayState(status, { busy = false, notice } = {}) {
  if (!status) return {
    status: 'stopped',
    summary: '○ Team DevSpace 未完成 Enrollment',
    remoteText: '暂停远程访问',
    remoteAction: 'suspend',
    remoteEnabled: false,
    checkEnabled: !busy,
    restartEnabled: false,
    repairEnabled: false,
    exitEnabled: !busy,
    ...(notice ? { notice } : {}),
  };
  const stopped = !status.devspace && !status.bridge && !status.tunnel;
  const gatewayState = status.gateway ?? status.remoteAccess;
  const desiredRemoteAccess = status.desiredRemoteAccess ?? status.remoteAccess;
  const suspended = gatewayState === 'suspended';
  const desiredSuspended = desiredRemoteAccess === 'suspended';
  const legacyResumeNeeded = desiredSuspended && gatewayState === 'active';
  const suspensionUnconfirmed = desiredSuspended && !['active', 'suspended'].includes(gatewayState);
  const visual = suspended ? 'suspended' : status.ready ? 'ready' : stopped ? 'stopped' : 'partial';
  const summary = suspensionUnconfirmed
    ? (stopped ? '○ Team DevSpace 本机已停止，网关状态未知' : '● Team DevSpace 暂停未完成')
    : legacyResumeNeeded && stopped ? '○ Team DevSpace 已停止，可恢复连接'
      : ({ ready: '● Team DevSpace 正常', partial: '● Team DevSpace 部分异常',
        suspended: '● Team DevSpace 远程访问已暂停', stopped: '○ Team DevSpace 已停止' })[visual];
  const enrolled = status.remoteAccess !== 'not-enrolled';
  const controllable = enrolled && gatewayState !== 'disabled';
  return {
    status: visual,
    summary,
    remoteText: suspended || legacyResumeNeeded ? '恢复远程访问'
      : suspensionUnconfirmed ? '重试暂停远程访问' : '暂停远程访问',
    remoteAction: suspended || legacyResumeNeeded ? 'resume' : 'suspend',
    remoteEnabled: !busy && controllable,
    checkEnabled: !busy,
    restartEnabled: !busy && controllable && !suspended && desiredRemoteAccess !== 'suspended',
    repairEnabled: !busy && controllable && !suspended && desiredRemoteAccess !== 'suspended',
    exitEnabled: !busy,
    ...(notice ? { notice } : {}),
  };
}

function actionNotice(action, status) {
  if (action === 'check') return `检查完成：${trayState(status).summary.replace(/^[●○] /, '')}`;
  if (action === 'suspend') return '远程访问已暂停';
  if (action === 'resume') return '远程访问已恢复';
  if (action === 'restart') return '连接服务已重新启动';
  if (action === 'repair') return '修复操作已完成';
  if (action === 'logs') return '日志目录已打开';
  return '诊断信息已复制';
}

function errorNotice(error) {
  return `操作失败：${String(error?.message ?? error).slice(0, 160)}`;
}

export async function runTray(home = stateHome(), options = {}) {
  const helper = options.helper ?? trayExecutable(options.root);
  const operations = options.operations ?? {
    status: () => deviceStatus(home),
    suspend: () => suspendRemoteAccess(home),
    resume: () => resumeRemoteAccess(home),
    restart: () => restartTeamDevSpace(home),
    repair: () => repairDevice(home, { preserveTray: true }),
    logs: () => openLogs(home),
    diagnostics: () => copyDiagnosticReport(home),
    exit: () => stopTeamDevSpace(home),
  };
  const child = spawn(helper, options.helperArgs ?? [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let helperClosed = false;
  let currentStatus = null;
  let mutationBusy = false;
  let generation = 0;
  let refreshPromise = null;
  let mutationPromise = Promise.resolve();
  let exiting = false;
  let interval;

  child.stdin.on('error', () => {});
  child.once('exit', () => { helperClosed = true; });
  const send = state => {
    if (!helperClosed && child.stdin.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(state)}\n`);
  };

  const refresh = async ({ notice = false } = {}) => {
    if (mutationBusy || exiting) return currentStatus;
    if (refreshPromise) {
      await refreshPromise;
      if (notice && currentStatus && !mutationBusy && !exiting) {
        send(trayState(currentStatus, { notice: actionNotice('check', currentStatus) }));
      }
      return currentStatus;
    }
    const startedAt = generation;
    refreshPromise = (async () => {
      try {
        const status = await operations.status();
        if (startedAt === generation && !mutationBusy && !exiting) {
          currentStatus = status;
          send(trayState(status, notice ? { notice: actionNotice('check', status) } : {}));
        }
        return status;
      } catch (error) {
        if (startedAt === generation && !mutationBusy && !exiting) {
          currentStatus = null;
          send(trayState(null, notice ? { notice: errorNotice(error) } : {}));
        }
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const runMutation = action => {
    if (mutationBusy || exiting) return;
    mutationBusy = true;
    generation++;
    send(trayState(currentStatus, { busy: true, notice: action === 'exit' ? '正在关闭 Team DevSpace…' : '正在执行操作…' }));
    mutationPromise = (async () => {
      try {
        const result = await operations[action]();
        if (action === 'exit') {
          exiting = true;
          if (interval) clearInterval(interval);
          send(trayState(currentStatus, { busy: true, notice: '本地服务已停止，正在退出…' }));
          child.stdin.end();
          return result;
        }
        const status = await operations.status();
        currentStatus = status;
        send(trayState(status, { notice: actionNotice(action, status) }));
        process.stdout.write(`[Team DevSpace tray] ${action}: ${actionNotice(action, status)}\n`);
        return result;
      } catch (error) {
        const message = errorNotice(error);
        try { currentStatus = await operations.status(); } catch {}
        send(trayState(currentStatus, { notice: message }));
        process.stderr.write(`[Team DevSpace tray] ${action}: ${message}\n`);
        return null;
      } finally {
        if (!exiting) {
          mutationBusy = false;
          generation++;
        }
      }
    })();
  };

  const runUtility = async action => {
    if (exiting) return;
    try {
      await operations[action]();
      const notice = actionNotice(action, currentStatus);
      send(trayState(currentStatus, { busy: mutationBusy, notice }));
      process.stdout.write(`[Team DevSpace tray] ${action}: ${notice}\n`);
    } catch (error) {
      const message = errorNotice(error);
      send(trayState(currentStatus, { busy: mutationBusy, notice: message }));
      process.stderr.write(`[Team DevSpace tray] ${action}: ${message}\n`);
    }
  };

  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.event === 'ready') void refresh();
      else if (event.event === 'protocol-error') process.stderr.write('[Team DevSpace tray] native protocol error\n');
      else if (event.event === 'menu' && event.action === 'check') void refresh({ notice: true });
      else if (event.event === 'menu' && ['logs', 'diagnostics'].includes(event.action)) void runUtility(event.action);
      else if (event.event === 'menu' && ['suspend', 'resume', 'restart', 'repair', 'exit'].includes(event.action)) runMutation(event.action);
    } catch {}
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  interval = setInterval(() => void refresh(), options.refreshInterval ?? 15000);
  interval.unref();

  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (interval) clearInterval(interval);
  await mutationPromise;
  if (exit.signal || exit.code !== 0) throw new Error(`Native tray exited unexpectedly (${exit.signal ?? exit.code})`);
}
