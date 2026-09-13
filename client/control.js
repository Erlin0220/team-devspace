/* Shared local UI: render controller facts; never infer or persist remote-access policy. */
const $ = id => document.getElementById(id);
const fragment = location.hash.slice(1);
if (/^[A-Za-z0-9_-]{43}$/.test(fragment)) sessionStorage.setItem('tds-control-token', fragment);
history.replaceState(null, '', location.pathname);
const token = sessionStorage.getItem('tds-control-token') ?? '';
let current, clientError, submitting = false, polling = false, rootEdited = false, loadingReport = false;
let activeAction;
const feedback = (message, error = false) => {
  $('feedback').hidden = !message;
  $('feedback').textContent = message ?? '';
  $('feedback').dataset.error = String(error);
};
async function request(path, body) {
  const signal = AbortSignal.timeout(body ? 180000 : 10000);
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
  }
}
function render(state) {
  current = state;
  const setup = state.accessKeyMode === 'setup';
  if (setup) $('key-settings').open = true;
  $('key-title').textContent = setup ? '完成设备设置' : '访问密钥';
  $('feedback').dataset.busy = String(Boolean(state.activity || submitting));
  $('feedback').setAttribute('aria-busy', String(Boolean(state.activity || submitting)));
  const nativePicker = ['win32', 'darwin'].includes(state.platform);
  $('identity').textContent = `${state.computer} · ${state.platform} ${state.architecture}`;
  $('version').textContent = `Team DevSpace ${state.version} · DevSpace ${state.devspaceVersion}`;
  $('author').textContent = `作者：${state.author.name} · ${state.author.email}`;
  $('summary').textContent = state.summary.replace(/^Team DevSpace /, '');
  $('checked-at').textContent = state.checkedAt ? `最近检查：${new Date(state.checkedAt).toLocaleTimeString()}` : '尚未完成状态检查';
  $('connection').textContent = state.activity ? '操作进行中' : state.status === 'ready' ? '已连接' : state.status === 'suspended' ? '已暂停' : '需要检查';
  $('connection').dataset.state = state.activity ? 'busy' : state.status;
  const entries = [['本机运行时', state.health?.devspace], ['本机桥接', state.health?.bridge], ['连接通道', state.health?.tunnel],
    ['服务端状态', state.health?.gateway], ['本机访问意图', state.health?.desiredRemoteAccess]];
  const words = { active: '开启', suspended: '暂停', disabled: '授权失效', unreachable: '无法连接', 'not-enrolled': '未绑定', 'invalid-response': '响应无效' };
  $('health').replaceChildren(...entries.flatMap(([name, value]) => {
    const key = document.createElement('dt'), item = document.createElement('dd');
    key.textContent = name;
    item.textContent = typeof value === 'boolean' ? (value ? '就绪' : '未就绪') : words[value] ?? '尚未确认';
    return [key, item];
  }));
  $('remote').textContent = state.remoteText;
  for (const [id, enabled] of [['remote', state.remoteEnabled], ['restart', state.restartEnabled],
    ['repair', state.repairEnabled], ['check', state.checkEnabled], ['save-project', state.projectRootEnabled],
    ['save-key', state.switchKeyEnabled], ['choose-folder', !state.busy]]) $(id).disabled = submitting || !enabled || state.exiting;
  $('access-key').disabled = submitting || state.busy || state.exiting;
  $('project-root').disabled = submitting || state.busy || state.exiting;
  if (!rootEdited && document.activeElement !== $('project-root')) $('project-root').value = state.projectRoot ?? '';
  $('current-root').textContent = setup ? ($('project-root').value ? `待使用：${$('project-root').value}` : '尚未选择项目目录') : state.projectRoot ?? '项目目录不可用';
  $('choose-folder').hidden = !nativePicker;
  $('choose-folder').textContent = submitting && ['choose-folder', 'project-root'].includes(activeAction)
    ? '正在处理目录…' : setup ? '选择项目目录…' : '更换项目目录…';
  if (!nativePicker) $('manual-project').open = true;
  $('save-project').hidden = setup;
  $('save-project').disabled ||= !rootEdited || !$('project-root').value.trim() || $('project-root').value.trim() === state.projectRoot;
  $('project-hint').textContent = setup ? '先选择项目目录，再输入 Access Key 完成设置。'
    : '在目录窗口确认后直接应用，取消则不更改。切换后需要在 ChatGPT 中重新连接；已暂停的访问不会自动恢复。';
  $('save-key').textContent = setup ? '完成设置并连接' : '更换 Access Key';
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
    if (name === 'choose-folder' && result.projectRoot) { $('project-root').value = result.projectRoot; rootEdited = true; }
    if (['setup', 'switch-key'].includes(name)) $('access-key').value = '';
    if (['project-root', 'setup'].includes(name)) rootEdited = false;
  } catch (error) { clientError = error.message; feedback(clientError, true); }
  finally { submitting = false; activeAction = undefined; await refresh(); }
}
$('project-root').addEventListener('input', () => { rootEdited = true; if (current) render(current); });
$('remote').addEventListener('click', () => action(current.remoteAction));
for (const name of ['restart', 'check', 'repair', 'logs']) $(name).addEventListener('click', () => action(name));
$('choose-folder').addEventListener('click', () => current?.accessKeyMode === 'setup'
  ? action('choose-folder', { projectRoot: $('project-root').value }) : action('project-root'));
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
  const target = { '/diagnostics': 'diagnostics-title', '/about': 'about-title' }[location.pathname];
  if (target) {
    $(target).scrollIntoView({ block: 'start' });
    $(target).focus({ preventScroll: true });
  }
});
setInterval(() => { if (!document.hidden) void refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
