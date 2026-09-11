import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { installRoot, stateHome } from './state.mjs';

export function trayExecutable(root = installRoot) {
  if (process.platform === 'win32') return join(root, 'platform', 'windows', 'team-devspace-tray.exe');
  if (process.platform === 'darwin') return join(root, 'platform', 'macos', 'Team DevSpace Tray.app',
    'Contents', 'MacOS', 'TeamDevSpaceTray');
  throw new Error('The native tray is available on Windows and macOS; use the CLI on Linux');
}

export async function trayInstanceId(home = stateHome()) {
  const canonical = await realpath(home).catch(error => {
    if (error.code === 'ENOENT') return resolve(home);
    throw error;
  });
  return createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
}

// Presentation only: lifecycle decisions remain in trayState/configureDevice.
export function macText(text = '') {
  return String(text).replace(/^Team DevSpace\s*/, '')
    .replace('未完成 Enrollment', '需要完成设置')
    .replace(/^正常$/, '已连接')
    .replace(/Team Gateway|Gateway/g, '连接服务')
    .replace(/本机服务/g, '本机连接')
    .replace(/重启连接服务/g, '重新连接');
}

const SETUP_PROGRESS = new Map([
  ['Preparing private device state...', '正在准备本机设置…'],
  ['Existing Enrollment found. Reusing the current Device Binding...', '正在恢复已有设置…'],
  ['Refreshing current-user login startup entries...', '正在更新登录启动设置…'],
  ['Contacting the Team Gateway and confirming Enrollment...', '正在验证 Access Key…'],
  ['Enrollment confirmed. Preparing the local runtime...', '正在准备连接…'],
  ['Installing current-user login startup entries...', '正在配置登录启动…'],
  ['Enrollment is complete. Remote access remains safely suspended.', '设置已完成，远程访问仍保持暂停。'],
  ['Enrollment is complete. Team DevSpace is connecting in the background.', '设置已完成，正在连接…'],
]);

export function macProgress(text) { return SETUP_PROGRESS.get(text) ?? macText(text); }

export function desktopErrorText(error) {
  const messages = {
    gateway_unreachable: '无法连接服务，请检查网络后重试。',
    invalid_access_key: 'Access Key 无效，请检查输入；仍失败请联系管理员重新发放。',
    access_key_already_bound: '这个 Access Key 已绑定其他设备，请联系管理员执行“重置设备绑定”后再试。',
    access_key_still_bound: '当前 Access Key 仍处于设备绑定状态；如需重新绑定，请联系管理员执行“重置设备绑定”后再试。',
    device_disabled: '当前设备绑定已失效，请重新输入 Access Key；如果 Key 已吊销，请联系管理员重新发放。',
    device_offline: '当前设备不可达，请检查网络和本机连接后重试。',
    device_not_ready: '本机连接尚未就绪，请稍后重试；持续失败可使用“诊断与修复”。',
    connectivity_cleanup_pending: '旧连接仍在清理，请稍后重试。',
    access_lifecycle_changed: '设备绑定状态已变化，请重新检查后再试。',
    invalid_gateway_response: '连接服务返回了无效响应，请稍后重试。',
    project_root_required: '请选择要让 Team DevSpace 操作的项目目录。',
    project_root_invalid: '请选择有效的项目目录。',
    project_root_unavailable: '项目目录不存在或不可访问，请通过“项目目录…”重新选择。',
    project_root_change_requires_command: '当前设备已完成绑定，请通过“项目目录…”修改项目目录。',
    project_root_conflict: '另一个安装流程已经选择了不同的项目目录，请检查当前项目后再继续。',
    multiple_project_roots_unsupported: 'Team DevSpace 当前只支持一个项目目录，请只选择一个项目。',
    ui_already_open: 'Access Key 设置窗口已经打开，请查看当前窗口。',
    'Enter the Access Key assigned by your administrator': '请输入管理员发放的完整 Access Key。',
    'Gateway returned an incompatible Enrollment': '连接服务版本不兼容，请联系管理员。',
  };
  const text = messages[error?.code ?? error?.message] ?? error?.message ?? '操作未完成，请重试。';
  // Desktop surfaces on both Windows and macOS must never echo bearer credentials.
  return String(text).replace(/tds_[A-Za-z0-9_-]+/g, '[已隐藏]').slice(0, 360);
}

export function macError(error) {
  return macText(desktopErrorText(error));
}
