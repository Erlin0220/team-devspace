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

export function macError(error) {
  const messages = {
    gateway_unreachable: '无法连接服务，请检查网络后重试。',
    invalid_access_key: 'Access Key 无效，请检查后重试。',
    access_key_already_bound: '这个 Access Key 已绑定其他电脑，请联系管理员。',
    device_disabled: '当前授权已失效，请联系管理员获取新的 Access Key。',
    invalid_gateway_response: '连接服务返回了无效响应，请稍后重试。',
    'Enter the Access Key assigned by your administrator': '请输入管理员发放的完整 Access Key。',
    'Gateway returned an incompatible Enrollment': '连接服务版本不兼容，请联系管理员。',
  };
  const text = messages[error?.code ?? error?.message] ?? error?.message ?? '操作未完成，请重试。';
  // Never echo credentials received through a secure field into a visible error.
  return macText(text).replace(/tds_[A-Za-z0-9_-]+/g, '[已隐藏]').slice(0, 360);
}
