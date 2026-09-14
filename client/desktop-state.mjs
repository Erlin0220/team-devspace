import { hostname } from 'node:os';
import { basename } from 'node:path';
import release from '../release.config.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };

function summaryOf(status) {
  if (!status) return { status: 'stopped', summary: 'Team DevSpace 未连接' };
  const gateway = status.gateway ?? status.remoteAccess;
  const desired = status.desiredRemoteAccess ?? status.remoteAccess;
  const stopped = !status.devspace && !status.bridge && !status.tunnel;
  let visual = 'partial';
  let text;
  if (status.remoteAccess === 'not-enrolled') { visual = 'stopped'; text = '未完成 Enrollment'; }
  else if (gateway === 'disabled') text = '授权已失效';
  else if (desired === 'suspended') {
    visual = stopped ? 'suspended' : 'partial';
    text = gateway === 'suspended' ? (stopped ? '远程访问已暂停' : '已暂停，本机清理未完成')
      : !stopped ? '暂停未完成' : gateway === 'active' ? '本机已暂停，服务端待确认' : '本机已暂停，服务端状态未知';
  } else if (gateway === 'suspended') { visual = 'suspended'; text = '服务端仍处于暂停状态'; }
  else if (status.currentProjectRootAvailable === false) text = '项目目录不可用';
  else if (status.ready) { visual = 'ready'; text = '已连接'; }
  else if (gateway === 'unreachable') { visual = stopped ? 'stopped' : 'partial'; text = '无法连接服务'; }
  else if (stopped) { visual = 'stopped'; text = '本机服务已停止'; }
  else if (!status.tunnel) text = '连接通道异常';
  else if (!status.devspace || !status.bridge) text = '本机服务异常';
  else text = '部分异常';
  return { status: visual, summary: `Team DevSpace ${text}` };
}

// Authorize native events using the same enabled tree the user can see.
export function findMenuAction(menu, action) {
  for (const item of menu) {
    if (!item.enabled) continue;
    if (item.children) {
      const child = findMenuAction(item.children, action);
      if (child) return child;
    } else if (item.action === action) return item;
  }
}

// Pure projection shared by both native renderers and the Control Center.
// No runtime dependencies: early native packaging smoke runs before npm ci.
export function desktopState(status, { busy = false, exiting = false, activity, notice, alert,
  accessKeyMode = 'setup', currentProjectRoot, updates } = {}) {
  const gateway = status?.gateway ?? status?.remoteAccess;
  const desired = status?.desiredRemoteAccess ?? status?.remoteAccess;
  const enrolled = Boolean(status && status.remoteAccess !== 'not-enrolled');
  const canReplaceKey = enrolled || accessKeyMode === 'replace-key';
  const suspended = desired === 'suspended' || gateway === 'suspended';
  const controllable = Boolean(status && enrolled && gateway !== 'disabled');
  const pausePending = desired === 'suspended' && gateway !== 'suspended';
  const root = status?.currentProjectRoot ?? currentProjectRoot;
  const view = {
    ...summaryOf(status), activity, notice, alert, gatewayCheckedAt: status?.gatewayCheckedAt ?? null,
    remoteText: pausePending ? '重试暂停远程访问' : gateway === 'suspended' ? '恢复远程访问' : '暂停远程访问',
    remoteAction: pausePending ? 'suspend' : gateway === 'suspended' ? 'resume' : 'suspend',
    remoteEnabled: !busy && controllable, checkEnabled: !busy,
    switchKeyText: canReplaceKey ? '更换 Access Key…' : '完成设置…',
    switchKeyEnabled: !busy, accessKeyMode: canReplaceKey ? 'replace-key' : 'setup',
    projectText: root ? `项目：${basename(root) || root}` : '项目：未设置', projectRoot: root,
    projectRootEnabled: !busy && Boolean(root),
    restartEnabled: !busy && controllable && !suspended,
    repairEnabled: !busy && (Boolean(status?.enrollmentPending) || (controllable && !suspended)),
    logsEnabled: !exiting, diagnosticsEnabled: !exiting,
    exitEnabled: !exiting,
    busy, exiting, version: release.version, devspaceVersion: release.devspaceVersion, computer: hostname(),
    author: { name: packageJson.author.name, email: packageJson.author.email },
    platform: process.platform, architecture: process.arch,
    health: status ? Object.fromEntries(['devspace', 'bridge', 'tunnel', 'gateway', 'desiredRemoteAccess',
      'currentProjectRootAvailable', 'ready'].map(key => [key, status[key]])) : null,
  };
  const item = (id, text, enabled, action = id) => ({ id, text, enabled, action });
  const separator = id => ({ id, text: '', enabled: false, separator: true });
  if (updates?.required) { view.status = 'partial'; view.summary = 'Team DevSpace 当前版本需要升级'; }
  view.iconStatus = alert ? 'partial' : activity ? 'busy' : view.status;
  view.tooltip = `Team DevSpace · ${alert ? '需要处理，点击查看设置' : activity ?? view.summary.replace(/^Team DevSpace /, '')}${root ? ` · ${basename(root)}` : ''}`;
  view.menu = [
    item('status', alert ? '操作未完成，请打开设置查看' : activity ?? view.summary, false, ''),
    item('device', `此设备：${view.computer}`, false, ''),
    item('project', view.projectText, false, ''), separator('main-separator'),
    item('remote', view.remoteText, view.remoteEnabled, view.remoteAction),
    item('settings', '设置…', !exiting),
    { id: 'troubleshoot', text: '诊断与修复', enabled: !exiting, children: [
      item('check', '检查连接', view.checkEnabled),
      item('restart', '重启连接', view.restartEnabled),
      item('repair', '修复连接', view.repairEnabled),
      separator('diagnostics-separator'),
      item('logs', '打开日志', view.logsEnabled),
      item('diagnostics', '查看完整诊断…', view.diagnosticsEnabled, 'troubleshoot'),
    ] },
    item('updates', updates?.required ? '需要升级才能继续远程工作…' : updates?.available ? `更新到 ${updates.policy.stable}…` : '软件更新…', !exiting),
    item('about', '关于 Team DevSpace…', !exiting), separator('exit-separator'),
    item('exit', '退出 Team DevSpace', !exiting),
  ];
  return view;
}
