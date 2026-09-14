/* Shared local UI: render controller facts; never infer or persist remote-access policy. */
const $ = id => document.getElementById(id);
const fragment = location.hash.slice(1);
if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) sessionStorage.setItem('tds-control-token', fragment);
history.replaceState(null, '', location.pathname);
const token = sessionStorage.getItem('tds-control-token') ?? '';
let current, clientError, submitting = false, polling = false, rootEdited = false, loadingReport = false, keyEditorOpen = false;
let activeAction;
const ROUTE_VIEW = { '/diagnostics': 'diagnostics', '/about': 'about', '/updates': 'updates' };
const VIEW_META = {
  overview: ['概览', '查看连接状态、项目信息和本机运行情况。'],
  settings: ['本机设置', '管理当前设备的项目目录和访问凭据。'],
  updates: ['软件更新', '保持客户端使用管理员批准的稳定版本。'],
  diagnostics: ['诊断与修复', '检查连接状态、查看日志并处理常见本机问题。'],
  about: ['关于', '查看 Team DevSpace 客户端和本机环境信息。'],
};
let activeView = ROUTE_VIEW[location.pathname] ?? 'overview';
let userSelectedView = false;
function clearSensitiveDrafts() {
  $('access-key').value = '';
  $('setup-access-key').value = '';
  keyEditorOpen = false;
  $('key-form').hidden = true;
  $('edit-key').hidden = current?.accessKeyMode === 'setup';
}
function showView(name, { user = false, focus = false } = {}) {
  if (!VIEW_META[name]) name = 'overview';
  if (activeView === 'settings' && name !== 'settings') clearSensitiveDrafts();
  activeView = name;
  if (user) userSelectedView = true;
  document.querySelectorAll('[data-view]').forEach(panel => { panel.hidden = panel.dataset.view !== name; });
  document.querySelectorAll('[data-view-target]').forEach(item => {
    if (item.dataset.viewTarget === name) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  $('view-title').textContent = VIEW_META[name][0];
  $('view-description').textContent = VIEW_META[name][1];
  if (focus) document.querySelector(`[data-view="${name}"] h2`)?.focus({ preventScroll: true });
}
showView(activeView);
const feedback = (message, error = false) => {
  $('feedback').hidden = !message;
  $('feedback').textContent = message ?? '';
  $('feedback').dataset.error = String(error);
};
async function request(path, body) {
  // Safari 15 (included with supported macOS 12) lacks AbortSignal.timeout.
  // One standard controller also lets successful requests release their timer.
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), body?.action === 'update-apply' ? 1900000 : body ? 180000 : 10000);
  try {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', signal,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '本地控制请求失败');
    return result;
  } catch (error) {
    // Losing the HTTP response does not cancel the controller transaction.
    // Keep polling its facts; never automatically repeat a binding mutation.
    if (signal.aborted) throw new Error(body
      ? '请求超时，操作结果尚未确认。请查看当前状态与日志，确认后再重试。'
      : '读取状态超时，请检查本地控制器。');
    if (body && error.name === 'TypeError') throw new Error('本地连接中断，操作结果尚未确认。请查看当前状态与日志。');
    throw error;
  } finally { clearTimeout(timer); }
}
function render(state) {
  current = state;
  document.body.dataset.clientState = state.activity ? 'busy' : state.status;
  const setup = state.accessKeyMode === 'setup';
  const windowsSetup = setup && state.platform === 'win32';
  if (setup && location.pathname === '/' && !userSelectedView && activeView === 'overview') showView('settings');
  if (setup) keyEditorOpen = true;
  $('settings-normal').hidden = windowsSetup;
  $('windows-setup').hidden = !windowsSetup;
  if (activeView === 'settings') {
    $('view-title').textContent = '本机设置';
    $('view-description').textContent = windowsSetup
      ? '配置本机的访问密钥和项目目录，完成后将自动连接 Team DevSpace。'
      : VIEW_META.settings[1];
  }
  $('key-title').textContent = setup ? '完成设备设置' : '访问密钥';
  $('key-status').textContent = setup
    ? '输入管理员发放的 Access Key，并选择项目目录完成首次设置。'
    : '当前设备已绑定 Access Key，密钥不会在页面中回显。';
  $('key-form').hidden = !keyEditorOpen;
  $('edit-key').hidden = setup || keyEditorOpen;
  $('cancel-key').hidden = setup;
  $('feedback').dataset.busy = String(Boolean(state.activity || submitting));
  $('feedback').setAttribute('aria-busy', String(Boolean(state.activity || submitting)));
  const nativePicker = ['win32', 'darwin'].includes(state.platform);
  $('identity').textContent = `${state.computer} · ${state.platform} ${state.architecture}`;
  $('version').textContent = `Team DevSpace ${state.version} · DevSpace ${state.devspaceVersion}`;
  $('author').textContent = `作者：${state.author.name} · ${state.author.email}`;
  $('sidebar-device-name').textContent = state.computer;
  $('sidebar-version').textContent = `v${state.version}`;
  $('about-device').textContent = `${state.computer} · ${state.platform} ${state.architecture}`;
  const platformName = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[state.platform] ?? state.platform;
  const root = state.projectRoot ?? '';
  $('overview-project-path').textContent = root || '尚未设置项目目录';
  $('overview-device-name').textContent = `${state.computer} · ${platformName} ${state.architecture}`;
  $('overview-device-meta').textContent = `Team DevSpace ${state.version} · DevSpace ${state.devspaceVersion}`;
  $('overview-version-badge').textContent = `版本 ${state.version}`;
  $('overview-runtime-state').textContent = state.status === 'ready' ? '所有系统服务运行正常' : state.summary.replace(/^Team DevSpace /, '');
  $('overview-runtime-meta').textContent = `${platformName} ${state.architecture}`;
  const updates = state.updates;
  $('nav-update-indicator').hidden = !(updates?.available || updates?.required);
  const updateState = updates?.error ? 'error' : updates?.required ? 'required' : updates?.available ? 'available' : 'current';
  $('update-state-icon').dataset.state = updateState;
  $('update-version').textContent = updateState === 'required' ? '需要升级'
    : updateState === 'available' ? `新版本 ${updates.policy.stable}`
    : updateState === 'error' ? '检查失败' : `当前 ${state.version}`;
  $('update-description').textContent = updateState === 'required' ? '当前版本需要升级'
    : updateState === 'available' ? `新版本 ${updates.policy.stable} 可用`
    : updateState === 'error' ? '检查更新失败'
    : updates?.checkedAt ? '当前已是最新版本' : '尚未检查软件更新';
  const updateDetails = [];
  if (updateState === 'required') {
    updateDetails.push(`当前 ${state.version}`);
    if (updates.policy?.minimumSupported) updateDetails.push(`最低支持 ${updates.policy.minimumSupported}`);
    if (updates.policy?.stable) updateDetails.push(`稳定版 ${updates.policy.stable}`);
  } else if (updateState === 'available') {
    updateDetails.push(`当前版本 ${state.version}`);
    updateDetails.push(updates.requiresAuthorization ? '安装时需要系统授权' : '更新期间连接会短暂重启');
  } else if (updateState === 'error') updateDetails.push(updates.error);
  else if (updates?.checkedAt) updateDetails.push(`当前版本 ${state.version}`, `上次检查 ${new Date(updates.checkedAt).toLocaleString()}`);
  else updateDetails.push('版本检查不会中断正在执行的远程请求。');
  if (updates?.policy?.minimumSupported && !updates.required) updateDetails.push(`最低支持 ${updates.policy.minimumSupported} · ${new Date(updates.policy.enforceAfter).toLocaleString()} 生效`);
  if (updates?.available && updates.automaticResult?.deferred) updateDetails.push(updates.automaticResult.message);
  if (updates?.lastInstall && updates.lastInstall.exitCode !== 0) updateDetails.push('上次安装未完成，请重新更新或运行固定下载站的安装包。');
  $('update-detail').textContent = updateDetails.join(' · ');
  $('update-auto').checked = updates?.automatic !== false;
  $('update-check').disabled = submitting || state.busy || state.exiting;
  $('update-apply').disabled = submitting || state.busy || state.exiting || !updates?.available;
  $('update-auto').disabled = submitting || state.busy || state.exiting;
  $('summary').textContent = state.summary.replace(/^Team DevSpace /, '');
  $('checked-at').textContent = state.checkedAt ? `本机检查：${new Date(state.checkedAt).toLocaleTimeString()}${state.gatewayCheckedAt ? ` · 服务端检查：${new Date(state.gatewayCheckedAt).toLocaleTimeString()}` : ''}` : '尚未完成状态检查';
  $('connection').textContent = state.activity ? '操作进行中' : state.status === 'ready' ? '已连接' : state.status === 'suspended' ? '已暂停' : '需要检查';
  $('connection').dataset.state = state.activity ? 'busy' : state.status;
  const entries = [['本机运行时', state.health?.devspace], ['本机桥接', state.health?.bridge], ['连接通道', state.health?.tunnel],
    ['服务端状态', state.health?.gateway], ['本机访问意图', state.health?.desiredRemoteAccess]];
  const words = { active: '开启', suspended: '暂停', disabled: '授权失效', unreachable: '无法连接', 'not-enrolled': '未绑定', 'invalid-response': '响应无效' };
  $('health').replaceChildren(...entries.map(([name, value]) => {
    const row = document.createElement('div');
    row.className = 'health-item';
    row.dataset.state = value === true || value === 'active' ? 'ready'
      : value === 'suspended' || value == null || value === 'not-enrolled' ||
        (value === false && state.health?.desiredRemoteAccess === 'suspended') ? 'neutral' : 'error';
    const key = document.createElement('dt'), item = document.createElement('dd');
    key.textContent = name;
    item.textContent = typeof value === 'boolean' ? (value ? '就绪' : '未就绪') : words[value] ?? '尚未确认';
    row.append(key, item);
    return row;
  }));
  $('remote').textContent = state.remoteText;
  for (const [id, enabled] of [['remote', state.remoteEnabled], ['restart', state.restartEnabled],
    ['repair', state.repairEnabled], ['check', state.checkEnabled], ['overview-check', state.checkEnabled], ['save-project', state.projectRootEnabled],
    ['save-key', state.switchKeyEnabled], ['edit-key', state.switchKeyEnabled], ['choose-folder', !state.busy],
    ['overview-project-settings', true]]) $(id).disabled = submitting || !enabled || state.exiting;
  $('cancel-key').disabled = submitting || state.busy || state.exiting;
  $('access-key').disabled = submitting || state.busy || state.exiting;
  $('project-root').disabled = submitting || state.busy || state.exiting;
  $('setup-access-key').disabled = submitting || state.busy || state.exiting;
  $('setup-choose-folder').disabled = submitting || state.busy || state.exiting;
  $('setup-later').disabled = submitting || state.busy || state.exiting;
  if (!rootEdited && document.activeElement !== $('project-root')) $('project-root').value = state.projectRoot ?? '';
  if (windowsSetup && !rootEdited && !$('setup-project-root').value) $('setup-project-root').value = state.projectRoot ?? '';
  $('current-root').textContent = setup ? ($('project-root').value ? `待使用：${$('project-root').value}` : '尚未选择项目目录') : state.projectRoot ?? '项目目录不可用';
  $('choose-folder').hidden = !nativePicker;
  $('manual-project').hidden = nativePicker;
  $('choose-folder').textContent = submitting && ['choose-folder', 'project-root'].includes(activeAction)
    ? '正在处理目录…' : setup ? '选择项目目录…' : '更换项目目录…';
  if (!nativePicker) $('manual-project').open = true;
  $('save-project').hidden = setup;
  $('save-project').disabled ||= !rootEdited || !$('project-root').value.trim() || $('project-root').value.trim() === state.projectRoot;
  $('project-hint').textContent = setup ? '先选择项目目录，再输入 Access Key 完成设置。'
    : '在目录窗口确认后直接应用，取消则不更改。切换后需要在 ChatGPT 中重新连接；已暂停的访问不会自动恢复。';
  $('save-key').textContent = setup ? '完成设置并连接' : '确认更换';
  $('key-hint').textContent = setup
    ? '密钥不会回显；完成设置后会自动清空。'
    : '密钥不会回显；更换会断开旧连接，并保留项目目录。';
  if (windowsSetup) {
    const keyReady = Boolean($('setup-access-key').value.trim());
    const rootReady = Boolean($('setup-project-root').value.trim());
    $('setup-submit').disabled = submitting || state.busy || state.exiting || !keyReady || !rootReady;
    $('setup-submit').textContent = submitting && activeAction === 'setup' ? '正在完成设置…' : '完成设置并连接';
    $('setup-choose-folder').textContent = submitting && activeAction === 'choose-folder' ? '正在打开目录…' : '选择目录…';
  }
  $('logs').disabled = state.exiting || submitting;
  $('diagnostics').disabled = state.exiting || loadingReport;
  $('copy').disabled = state.exiting;
  if (submitting) {
    // The request stays pending while lifecycle work runs. Polling must still
    // render controller progress rather than freeze on the initial placeholder.
    if (state.activity || state.alert) feedback(state.alert ?? state.activity, Boolean(state.alert));
  } else feedback(clientError ?? state.alert ?? state.activity ?? state.notice, Boolean(clientError ?? state.alert));
}
async function refresh() {
  if (polling) return;
  polling = true;
  try { render(await request('/api/state')); }
  catch (error) {
    feedback(`${error.message}。若应用已退出，请重新启动并从托盘打开控制中心。`, true);
    $('connection').textContent = '本地控制器不可用';
    $('connection').dataset.state = 'stopped';
    $('feedback').dataset.busy = 'false';
    $('feedback').setAttribute('aria-busy', 'false');
    for (const button of document.querySelectorAll('button')) button.disabled = true;
  } finally { polling = false; }
}
async function action(name, input = {}) {
  if (submitting) return;
  submitting = true; activeAction = name; clientError = undefined;
  if (current) render(current);
  feedback(name === 'choose-folder' || (name === 'project-root' && input.projectRoot === undefined)
    ? '正在打开目录选择窗口…' : '正在处理，请稍候…');
  try {
    const result = await request('/api/action', { action: name, ...input });
    if (name === 'choose-folder' && result.projectRoot) {
      $('project-root').value = result.projectRoot;
      $('setup-project-root').value = result.projectRoot;
      rootEdited = true;
    }
    if (['setup', 'switch-key'].includes(name)) {
      $('access-key').value = '';
      $('setup-access-key').value = '';
      keyEditorOpen = false;
    }
    if (['project-root', 'setup'].includes(name)) rootEdited = false;
  } catch (error) { clientError = error.message; feedback(clientError, true); }
  finally { submitting = false; activeAction = undefined; await refresh(); }
}
$('project-root').addEventListener('input', () => { rootEdited = true; if (current) render(current); });
$('setup-access-key').addEventListener('input', () => { if (current) render(current); });
$('overview-check').addEventListener('click', () => action('check'));
$('overview-project-settings').addEventListener('click', () => {
  showView('settings', { user: true, focus: false });
  document.querySelector('.project-setting')?.scrollIntoView({ block: 'start' });
  if (!$('choose-folder').hidden && !$('choose-folder').disabled) $('choose-folder').focus({ preventScroll: true });
});
for (const item of document.querySelectorAll('[data-view-target]')) item.addEventListener('click', () => showView(item.dataset.viewTarget, { user: true, focus: true }));
$('remote').addEventListener('click', () => action(current.remoteAction));
$('edit-key').addEventListener('click', () => { keyEditorOpen = true; if (current) render(current); $('access-key').focus(); });
$('cancel-key').addEventListener('click', () => { clearSensitiveDrafts(); if (current) render(current); });
$('update-check').addEventListener('click', () => action('update-check'));
$('update-apply').addEventListener('click', () => {
  if (confirm('更新会短暂重启连接，保留设备绑定、项目目录和暂停状态。继续吗？')) action('update-apply');
});
$('update-auto').addEventListener('change', () => action('update-auto', { enabled: $('update-auto').checked }));
for (const name of ['restart', 'check', 'repair', 'logs']) $(name).addEventListener('click', () => action(name));
$('choose-folder').addEventListener('click', () => current?.accessKeyMode === 'setup'
  ? action('choose-folder', { projectRoot: $('project-root').value }) : action('project-root'));
$('setup-choose-folder').addEventListener('click', () => action('choose-folder', { projectRoot: $('setup-project-root').value }));
$('project-form').addEventListener('submit', event => {
  event.preventDefault();
  if (current?.accessKeyMode === 'setup') return;
  if (confirm('切换项目目录将重启当前项目连接。继续吗？')) action('project-root', { projectRoot: $('project-root').value.trim() });
});
$('key-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = current?.accessKeyMode === 'setup' ? 'setup' : 'switch-key';
  if (name === 'switch-key' && !confirm('更换 Access Key 会释放当前绑定、断开旧连接，并使用新 Key 重新绑定。继续吗？')) return;
  action(name, { accessKey: $('access-key').value.trim(), ...(name === 'setup' ? { projectRoot: $('project-root').value.trim() } : {}) });
});
$('setup-form').addEventListener('submit', event => {
  event.preventDefault();
  action('setup', {
    accessKey: $('setup-access-key').value.trim(),
    projectRoot: $('setup-project-root').value.trim(),
  });
});
$('setup-later').addEventListener('click', () => showView('overview', { user: true, focus: true }));
$('diagnostics').addEventListener('click', async () => {
  loadingReport = true; $('diagnostics').disabled = true;
  try {
    $('report').textContent = JSON.stringify(await request('/api/diagnostics'), null, 2);
    $('report').hidden = false; $('copy').hidden = false;
  } catch (error) { feedback(error.message, true); }
  finally { loadingReport = false; $('diagnostics').disabled = false; }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('report').textContent); feedback('诊断信息已复制'); }
  catch { feedback('浏览器未允许复制，请从下方诊断文本中手动复制。', true); }
});
void refresh().then(() => {
  const target = { '/diagnostics': 'diagnostics-title', '/about': 'about-title', '/updates': 'updates-title' }[location.pathname];
  if (target) {
    showView(ROUTE_VIEW[location.pathname], { focus: false });
    $(target).scrollIntoView({ block: 'start' });
    $(target).focus({ preventScroll: true });
  }
});
setInterval(() => { if (!document.hidden) void refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
