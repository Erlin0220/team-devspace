import { spawn } from 'node:child_process';
import { trayExecutable, trayInstanceId, macError, macProgress } from './desktop.mjs';
import { stateHome } from './state.mjs';

// The same executable renders tray and short-lived forms. There is no UI server,
// on-disk request file, or credential on argv. Only Node commits device changes.
export async function runMacForm({ home = stateHome(), mode = 'setup', projectRoot, submit,
  signal, onProgress = () => {}, helper, helperArgs, startupTimeout = 10000 } = {}) {
  if (signal?.aborted) return { cancelled: true };
  if (typeof submit !== 'function') throw new TypeError('A form submission handler is required');
  const child = spawn(helper ?? trayExecutable(), helperArgs ?? ['form'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEAM_DEVSPACE_TRAY_INSTANCE_ID: await trayInstanceId(home) },
  });
  let closed = false;
  let closing = false;
  let completed = false;
  let busy = false;
  let ready = false;
  let visible = false;
  let result;
  let failure;
  let pending = Promise.resolve();
  let buffer = '';
  let shutdownTimer;
  const send = value => {
    if (!closed && child.stdin.writable && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`);
  };
  const end = () => {
    if (closed || child.stdin.writableEnded) return;
    child.stdin.end();
    shutdownTimer = setTimeout(() => { if (!closed) child.kill(); }, 3000);
    shutdownTimer.unref();
  };
  const cancel = () => {
    if (closing) return;
    closing = true;
    if (busy) send({ type: 'form-result', phase: 'busy', message: '正在结束当前操作，请勿重复操作…' });
    else end();
  };
  const fail = () => {
    if (failure) return;
    failure = new Error('macOS 界面通信中断，请重新打开 Team DevSpace。');
    cancel();
  };
  const startupTimer = setTimeout(() => { failure = new Error('macOS 界面未能显示，请重新打开 Team DevSpace。'); cancel(); }, startupTimeout);
  startupTimer.unref();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  child.stdin.on('error', () => {});
  // The native helper never receives a credential on argv. Buffer complete stderr lines,
  // redact credential-shaped values and keep only bounded diagnostics for launch failures.
  let stderrBuffer = '';
  const logNativeStderr = line => {
    const safe = String(line).replace(/tds_[A-Za-z0-9_-]+/g, '[已隐藏]').replace(/[\r\n]+/g, ' ').slice(0, 1000);
    if (safe) process.stderr.write(`[Team DevSpace macOS UI] ${safe}\n`);
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderrBuffer += chunk;
    if (stderrBuffer.length > 8192) {
      logNativeStderr('native stderr exceeded the diagnostic limit');
      stderrBuffer = '';
    }
    let newline;
    while ((newline = stderrBuffer.indexOf('\n')) !== -1) {
      logNativeStderr(stderrBuffer.slice(0, newline));
      stderrBuffer = stderrBuffer.slice(newline + 1);
    }
  });
  const receive = event => {
    if (event.event === 'ready' && !ready) {
      ready = true;
      if (!closing) send({ type: 'form', mode, projectRoot: projectRoot ?? '' });
    } else if (event.event === 'form-visible' && ready && !visible) {
      visible = true;
      clearTimeout(startupTimer);
    } else if (event.event === 'duplicate') {
      clearTimeout(startupTimer);
      failure = Object.assign(new Error('Access Key 设置窗口已经打开，请查看当前窗口。'), { code: 'ui_already_open' });
      cancel();
    } else if (event.event === 'cancel') cancel();
    else if (event.event === 'submit' && ready && visible && !closing && !busy && !completed) {
      if (typeof event.accessKey !== 'string' || event.accessKey.length > 256 ||
          (mode === 'setup' && (typeof event.projectRoot !== 'string' || !event.projectRoot || event.projectRoot.length > 4096))) {
        fail(); return;
      }
      busy = true;
      send({ type: 'form-result', phase: 'busy', message: '正在验证 Access Key…' });
      pending = Promise.resolve().then(() => submit({ accessKey: event.accessKey.trim(),
        ...(mode === 'setup' ? { currentProjectRoot: event.projectRoot } : {}) }, message => {
        const text = macProgress(message);
        onProgress(text);
        if (!closing) send({ type: 'form-result', phase: 'busy', message: text });
      })).then(value => {
        result = value;
        completed = true;
        if (!closing) send({ type: 'form-result', phase: 'success', message: value?.remoteAccess === 'suspended'
          ? '设置已完成，远程访问仍保持暂停。' : '设置已完成，连接状态请查看菜单栏。' });
      }, error => {
        const message = macError(error);
        process.stderr.write(`[Team DevSpace ${mode}] ${message}\n`);
        if (!closing) send({ type: 'form-result', phase: 'error', message });
      }).finally(() => { busy = false; if (closing) end(); });
    } else if (event.event === 'protocol-error') fail();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    // Native output is bounded even when a buggy helper never sends a newline.
    if (buffer.length > 65536) { buffer = ''; fail(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try { receive(JSON.parse(line)); } catch { fail(); }
    }
  });
  try {
    const exit = await new Promise(resolve => {
      child.once('error', () => { failure = new Error('无法启动 macOS 原生界面，请修复安装后重试。'); resolve({ code: -1 }); });
      child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    closed = true;
    if (stderrBuffer) { logNativeStderr(stderrBuffer); stderrBuffer = ''; }
    // A disappearing UI is not permission to abandon a binding transaction.
    // The tray's exit path must wait for this promise before stopping services.
    await pending;
    if (failure) throw failure;
    if (!closing || exit.code !== 0) throw new Error(`macOS 原生界面意外退出（${exit.signal ?? exit.code}），请重新打开后检查连接状态。`);
    return completed ? result : { cancelled: true };
  } finally {
    closed = true;
    clearTimeout(startupTimer);
    clearTimeout(shutdownTimer);
    signal?.removeEventListener('abort', cancel);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
