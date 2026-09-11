import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyDiagnosticReport, openLogs, restartTeamDevSpace, resumeRemoteAccess,
  stopTeamDevSpace, suspendRemoteAccess } from './control.mjs';
import { deviceStatus, macSetupDialog, macReplaceAccessKey, promptReplacementAccessKey, repairDevice, replaceAccessKey } from './setup.mjs';
import { stateHome } from './state.mjs';
import { trayExecutable, trayInstanceId, macText } from './desktop.mjs';
export { trayExecutable, trayInstanceId } from './desktop.mjs';

const ACTIVITY_TEXT = {
  check: '正在检查连接…',
  suspend: '正在暂停远程访问…',
  resume: '正在恢复远程访问…',
  restart: '正在重启连接服务…',
  repair: '正在修复连接…',
  'switch-key': '等待输入 Access Key…',
  exit: '正在关闭 Team DevSpace…',
};

const ACTION_TEXT = {
  check: '检查连接', suspend: '暂停远程访问', resume: '恢复远程访问',
  restart: '重启连接服务', repair: '修复连接', 'switch-key': '设置 Access Key',
  logs: '打开日志', diagnostics: '复制诊断信息', exit: '关闭 Team DevSpace',
};

const ERROR_TEXT = {
  gateway_unreachable: '无法连接 Team Gateway，请检查网络后重试',
  invalid_access_key: 'Access Key 无效，请检查后重试',
  access_key_already_bound: 'Access Key 已绑定到其他设备',
  device_disabled: '当前设备授权已失效，请更换 Access Key',
  device_offline: '设备当前不可达',
  device_not_ready: '本机连接服务尚未就绪',
  connectivity_cleanup_pending: '旧连接正在清理，请稍后重试',
  access_lifecycle_changed: '连接状态已经变化，请重新检查后再试',
};

function traySummary(status, gatewayState, desiredRemoteAccess) {
  const enrolled = status.remoteAccess !== 'not-enrolled';
  if (!enrolled) return { visual: 'stopped', text: 'Team DevSpace 未完成 Enrollment' };
  if (gatewayState === 'disabled') return { visual: 'partial', text: 'Team DevSpace 授权已失效' };
  const stopped = !status.devspace && !status.bridge && !status.tunnel;
  const desiredSuspended = desiredRemoteAccess === 'suspended';
  if (desiredSuspended) {
    if (gatewayState === 'suspended') return stopped
      ? { visual: 'suspended', text: 'Team DevSpace 远程访问已暂停' }
      : { visual: 'partial', text: 'Team DevSpace 已暂停，本机清理未完成' };
    if (!stopped) return { visual: 'partial', text: 'Team DevSpace 暂停未完成' };
    if (gatewayState === 'active') return { visual: 'suspended', text: 'Team DevSpace 本机已暂停，服务端待确认' };
    return { visual: 'suspended', text: 'Team DevSpace 本机已暂停，服务端状态未知' };
  }
  if (gatewayState === 'suspended') return { visual: 'suspended', text: 'Team DevSpace 服务端仍处于暂停状态' };
  if (status.ready) return { visual: 'ready', text: 'Team DevSpace 正常' };
  if (gatewayState === 'unreachable') return { visual: stopped ? 'stopped' : 'partial', text: 'Team DevSpace 无法连接服务' };
  if (stopped) return { visual: 'stopped', text: 'Team DevSpace 本机服务已停止' };
  if (!status.tunnel) return { visual: 'partial', text: 'Team DevSpace 连接通道异常' };
  if (!status.devspace || !status.bridge) return { visual: 'partial', text: 'Team DevSpace 本机服务异常' };
  return { visual: 'partial', text: 'Team DevSpace 部分异常' };
}

export function trayState(status, { busy = false, exiting = false, activity, alert, diagnosticsCopied = false } = {}) {
  if (!status) return {
    status: 'stopped',
    summary: 'Team DevSpace 未连接',
    activity: activity || undefined,
    alert: alert || undefined,
    remoteText: '暂停远程访问',
    remoteAction: 'suspend',
    remoteEnabled: false,
    checkEnabled: !busy,
    switchKeyText: '完成设置…',
    switchKeyEnabled: false,
    restartEnabled: false,
    repairEnabled: false,
    logsEnabled: true,
    diagnosticsEnabled: true,
    diagnosticsText: diagnosticsCopied ? '诊断信息已复制' : '复制诊断信息',
    exitEnabled: !exiting,
  };
  const gatewayState = status.gateway ?? status.remoteAccess;
  const desiredRemoteAccess = status.desiredRemoteAccess ?? status.remoteAccess;
  const desiredSuspended = desiredRemoteAccess === 'suspended';
  const gatewaySuspended = gatewayState === 'suspended';
  const pausePending = desiredSuspended && !gatewaySuspended;
  const enrolled = status.remoteAccess !== 'not-enrolled';
  const controllable = enrolled && gatewayState !== 'disabled';
  const summary = traySummary(status, gatewayState, desiredRemoteAccess);
  return {
    status: summary.visual,
    summary: summary.text,
    activity: activity || undefined,
    alert: alert || undefined,
    remoteText: pausePending ? '重试暂停远程访问' : gatewaySuspended ? '恢复远程访问' : '暂停远程访问',
    remoteAction: pausePending ? 'suspend' : gatewaySuspended ? 'resume' : 'suspend',
    remoteEnabled: !busy && controllable,
    checkEnabled: !busy,
    switchKeyText: enrolled ? '更换 Access Key…' : '完成设置…',
    switchKeyEnabled: !busy && (enrolled || gatewayState === 'not-enrolled'),
    restartEnabled: !busy && controllable && !desiredSuspended && !gatewaySuspended,
    repairEnabled: !busy && (Boolean(status.enrollmentPending) ||
      (controllable && !desiredSuspended && !gatewaySuspended)),
    logsEnabled: true,
    diagnosticsEnabled: true,
    diagnosticsText: diagnosticsCopied ? '诊断信息已复制' : '复制诊断信息',
    exitEnabled: !exiting,
  };
}

function errorText(error) {
  const code = error?.code ?? error?.message;
  return (code && ERROR_TEXT[code]) || String(error?.message ?? error).slice(0, 220);
}

function actionError(action, error) {
  return `${ACTION_TEXT[action] ?? '操作'}失败：${errorText(error)}`;
}

export async function runTray(home = stateHome(), options = {}) {
  const helper = options.helper ?? trayExecutable(options.root);
  const child = spawn(helper, options.helperArgs ?? [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEAM_DEVSPACE_TRAY_INSTANCE_ID: await trayInstanceId(home) } });
  let helperClosed = false;
  let currentStatus = null;
  let mutationBusy = false;
  let currentActivity;
  let generation = 0;
  let refreshPromise = null;
  let mutationPromise = Promise.resolve();
  let exiting = false;
  let exitRequested = false;
  let operationAbort;
  let exitPromise = Promise.resolve();
  let interval;
  let diagnosticsTimer;
  let shutdownTimer;
  const utilities = new Map();

  child.stdin.on('error', () => {});
  child.once('exit', () => { helperClosed = true; });
  const send = state => {
    if (!helperClosed && child.stdin.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(state)}\n`);
  };
  const present = extra => {
    const value = trayState(currentStatus, {
      busy: mutationBusy || exitRequested, exiting: exitRequested, activity: currentActivity, ...extra,
    });
    if (process.platform === 'darwin') {
      value.summary = macText(value.summary);
      if (value.activity) value.activity = macText(value.activity);
      if (value.alert) value.alert = macText(value.alert);
    }
    send(value);
  };

  const operations = options.operations ?? {
    status: () => deviceStatus(home),
    suspend: () => suspendRemoteAccess(home),
    resume: () => resumeRemoteAccess(home),
    restart: () => restartTeamDevSpace(home),
    repair: () => repairDevice(home, { preserveTray: true }),
    'switch-key': async ({ signal, onProgress }) => {
      if (process.platform === 'darwin') {
        return currentStatus?.remoteAccess === 'not-enrolled'
          ? macSetupDialog(home, { preserveTray: true, signal })
          : macReplaceAccessKey(home, { signal, onProgress });
      }
      const accessKey = await promptReplacementAccessKey({ signal });
      if (!accessKey || signal.aborted) return { cancelled: true };
      onProgress('正在验证新的 Access Key…');
      return replaceAccessKey(accessKey, home, { onProgress });
    },
    logs: () => openLogs(home),
    diagnostics: () => copyDiagnosticReport(home),
    exit: () => stopTeamDevSpace(home),
  };

  const refresh = async () => {
    if (mutationBusy || exitRequested) return currentStatus;
    if (refreshPromise) return refreshPromise;
    const startedAt = generation;
    refreshPromise = (async () => {
      try {
        const status = await operations.status();
        if (startedAt === generation && !mutationBusy && !exiting) {
          currentStatus = status;
          present();
        }
        return status;
      } catch {
        if (startedAt === generation && !mutationBusy && !exiting) {
          currentStatus = null;
          present();
        }
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  const runCheck = () => {
    if (mutationBusy || exitRequested) return;
    mutationBusy = true;
    currentActivity = ACTIVITY_TEXT.check;
    generation++;
    present();
    mutationPromise = (async () => {
      let alert;
      try {
        currentStatus = await (refreshPromise ?? operations.status());
      } catch (error) {
        currentStatus = null;
        alert = actionError('check', error);
      } finally {
        if (!exitRequested) {
          mutationBusy = false;
          currentActivity = undefined;
          generation++;
          present(alert ? { alert } : undefined);
        }
      }
    })();
  };

  const runMutation = action => {
    if (mutationBusy || exitRequested) return;
    mutationBusy = true;
    operationAbort = new AbortController();
    currentActivity = ACTIVITY_TEXT[action] ?? '正在执行操作…';
    generation++;
    present();
    mutationPromise = (async () => {
      let alert;
      try {
        const result = await operations[action]({ signal: operationAbort.signal,
          onProgress: message => { if (!exitRequested) { currentActivity = message; present(); } } });
        if (exitRequested) return result;
        currentStatus = await operations.status();
        process.stdout.write(`[Team DevSpace tray] ${action}: ${result?.cancelled ? 'cancelled' : 'complete'}\n`);
        return result;
      } catch (error) {
        if (exitRequested && error.name === 'AbortError') return null;
        if (!exitRequested) { try { currentStatus = await operations.status(); } catch {} }
        alert = actionError(action, error);
        process.stderr.write(`[Team DevSpace tray] ${action}: ${alert}\n`);
        return null;
      } finally {
        operationAbort = undefined;
        if (!exitRequested) {
          mutationBusy = false;
          currentActivity = undefined;
          generation++;
          present(alert ? { alert } : undefined);
        }
      }
    })();
  };

  // Exit is not an ordinary mutation: a pending input dialog must not disable it.
  // Cancel only the prompt; an already-started binding transaction must settle
  // before stopping services, or it could restart them after the user exits.
  const requestExit = () => {
    if (exitRequested) return;
    exitRequested = true;
    operationAbort?.abort();
    currentActivity = mutationBusy ? '正在结束当前操作并退出…' : ACTIVITY_TEXT.exit;
    generation++;
    present();
    exitPromise = (async () => {
      try {
        await mutationPromise;
        await operations.exit();
        exiting = true;
        clearInterval(interval);
        clearTimeout(diagnosticsTimer);
        currentActivity = '本地服务已停止，正在退出…';
        present();
        child.stdin.end();
        shutdownTimer = setTimeout(() => { if (!helperClosed) child.kill(); }, 3000);
        shutdownTimer.unref();
      } catch (error) {
        exitRequested = false;
        mutationBusy = false;
        currentActivity = undefined;
        generation++;
        present({ alert: actionError('exit', error) });
      }
    })();
  };

  const runUtility = action => {
    if (exitRequested || utilities.has(action)) return;
    const pending = (async () => {
      try {
        await operations[action]();
        if (exitRequested) return;
        if (action === 'diagnostics') {
          clearTimeout(diagnosticsTimer);
          present({ diagnosticsCopied: true });
          diagnosticsTimer = setTimeout(() => present(), 1400);
          diagnosticsTimer.unref?.();
        }
        process.stdout.write(`[Team DevSpace tray] ${action}: complete\n`);
      } catch (error) {
        const message = actionError(action, error);
        if (!exitRequested) present({ alert: message });
        process.stderr.write(`[Team DevSpace tray] ${action}: ${message}\n`);
      }
    })();
    utilities.set(action, pending);
    void pending.finally(() => utilities.delete(action));
  };

  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.event === 'ready') void refresh();
      else if (event.event === 'protocol-error') process.stderr.write('[Team DevSpace tray] native protocol error\n');
      else if (event.event === 'menu' && event.action === 'check') runCheck();
      else if (event.event === 'menu' && ['logs', 'diagnostics'].includes(event.action)) void runUtility(event.action);
      else if (event.event === 'menu' && event.action === 'exit') requestExit();
      else if (event.event === 'menu' && ['suspend', 'resume', 'restart', 'repair', 'switch-key'].includes(event.action)) runMutation(event.action);
    } catch {}
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  interval = setInterval(() => void refresh(), options.refreshInterval ?? 5000);
  interval.unref();

  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(interval);
  clearTimeout(diagnosticsTimer);
  clearTimeout(shutdownTimer);
  operationAbort?.abort();
  await mutationPromise;
  await exitPromise;
  if (!exiting && (exit.signal || exit.code !== 0)) throw new Error(`Native tray exited unexpectedly (${exit.signal ?? exit.code})`);
}
