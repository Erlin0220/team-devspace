const PENDING_KEY = 'team-devspace.pending-access-key';

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function generateAccessKey(cryptoApi = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  return { id: cryptoApi.randomUUID(), accessKey: `tds_${base64Url(bytes)}` };
}

export async function hashAccessKey(accessKey, cryptoApi = globalThis.crypto) {
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(accessKey));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createPendingCredential(label, cryptoApi = globalThis.crypto) {
  const generated = generateAccessKey(cryptoApi);
  return { ...generated, label, keyHash: await hashAccessKey(generated.accessKey, cryptoApi) };
}

export function credentialRequest(credential) {
  return { id: credential.id, label: credential.label, keyHash: credential.keyHash };
}

export function savePendingCredential(storage, credential) {
  storage.setItem(PENDING_KEY, JSON.stringify(credential));
}

export function loadPendingCredential(storage) {
  try {
    const value = JSON.parse(storage.getItem(PENDING_KEY));
    return value?.id && value?.accessKey && value?.keyHash ? value : null;
  } catch { return null; }
}

export function clearPendingCredential(storage) {
  storage.removeItem(PENDING_KEY);
}

function errorText(code) {
  return ({
    key_label_or_id_conflict: '名称或密钥 ID 已存在',
    key_not_found: '未找到该访问密钥',
    revoked_key_cannot_be_reset: '已吊销的密钥不能重置设备',
    connectivity_cleanup_pending: '远程连接已禁用，但云端清理尚未完成',
    access_lifecycle_changed: '访问密钥状态已发生变化，请刷新页面后重试',
    invalid_key_request: '访问密钥请求无效',
    request_failed: '请求失败',
  })[code] ?? code ?? '未知错误';
}

async function adminJson(path, options) {
  const response = await fetch(path, { ...options, redirect: 'manual' });
  if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
    throw new Error('管理员登录已过期，请刷新页面后重新登录。');
  }
  if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new Error('管理服务返回了异常响应，请刷新页面后重新登录。');
  }
  return { response, result: await response.json() };
}

async function issueCredential(credential) {
  const { response, result } = await adminJson('/admin/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentialRequest(credential)),
  });
  if (!response.ok) {
    const error = new Error(errorText(result.error));
    error.code = result.error;
    error.retryable = Boolean(result.retryable);
    throw error;
  }
  return result;
}

function initialize() {
  const dialog = document.querySelector('#create-dialog');
  const createPanel = document.querySelector('#create-panel');
  const credentialPanel = document.querySelector('#credential-panel');
  const credentialOutput = document.querySelector('#credential');
  const pageNotice = document.querySelector('#notice');
  const dialogNotice = document.querySelector('#dialog-notice');
  const dialogTitle = document.querySelector('#dialog-title');
  const createForm = document.querySelector('#create-key');
  const createSubmit = document.querySelector('#create-submit');
  const retryButton = document.querySelector('#retry-key');

  const showNotice = (target, message) => {
    target.textContent = message;
    target.hidden = false;
  };
  const clearNotice = target => {
    target.textContent = '';
    target.hidden = true;
  };
  const setBusy = (button, busy) => {
    button.disabled = busy;
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  };
  const openDialog = () => {
    if (!dialog.open) dialog.showModal();
  };
  const showCreateForm = () => {
    dialogTitle.textContent = '创建访问密钥';
    credentialPanel.hidden = true;
    createPanel.hidden = false;
    retryButton.hidden = true;
    clearNotice(dialogNotice);
    createForm.reset();
    openDialog();
    requestAnimationFrame(() => createForm.elements.label?.focus());
  };
  const showCredential = (credential, needsRetry = false) => {
    dialogTitle.textContent = needsRetry ? '继续创建访问密钥' : '访问密钥已创建';
    credentialOutput.textContent = credential.accessKey;
    credentialPanel.hidden = false;
    createPanel.hidden = true;
    retryButton.hidden = !needsRetry;
    openDialog();
  };

  for (const time of document.querySelectorAll('.local-time')) {
    const date = new Date(time.dateTime);
    if (!Number.isNaN(date.getTime())) {
      time.title = time.dateTime;
      time.textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }
  }

  let pending = loadPendingCredential(sessionStorage);
  if (pending) {
    showCredential(pending, true);
    showNotice(dialogNotice, '检测到上次未完成的访问密钥，请使用同一密钥重试，不要重新生成。');
  }

  document.querySelector('#show-create').addEventListener('click', () => {
    if (pending) {
      showCredential(pending, true);
      showNotice(dialogNotice, '该密钥尚未确认保存，可以继续复制或重试同步。');
      return;
    }
    showCreateForm();
  });
  document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
  document.querySelector('#cancel-create').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });

  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    const label = new FormData(event.currentTarget).get('label')?.trim();
    if (!label) return;
    clearNotice(dialogNotice);
    setBusy(createSubmit, true);
    try {
      pending ??= await createPendingCredential(label);
      savePendingCredential(sessionStorage, pending);
      await issueCredential(pending);
      showCredential(pending, false);
    } catch (error) {
      if (error.code === 'key_label_or_id_conflict') {
        clearPendingCredential(sessionStorage);
        pending = null;
        dialogTitle.textContent = '创建访问密钥';
        credentialPanel.hidden = true;
        createPanel.hidden = false;
        createForm.elements.label.value = label;
        showNotice(dialogNotice, `创建失败：${error.message}，请更换名称后重试。`);
        requestAnimationFrame(() => createForm.elements.label?.select());
      } else {
        if (pending) showCredential(pending, true);
        showNotice(dialogNotice, `创建失败：${error.message}。再次重试时会继续使用同一个密钥。`);
      }
    } finally {
      setBusy(createSubmit, false);
    }
  });

  retryButton.addEventListener('click', async () => {
    if (!pending) return;
    clearNotice(dialogNotice);
    setBusy(retryButton, true);
    try {
      await issueCredential(pending);
      showCredential(pending, false);
    } catch (error) {
      showNotice(dialogNotice, `重试失败：${error.message}`);
    } finally {
      setBusy(retryButton, false);
    }
  });

  document.querySelector('#copy-key').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(credentialOutput.textContent);
      showNotice(dialogNotice, '访问密钥已复制。');
    } catch {
      showNotice(dialogNotice, '复制失败，请手动选择并复制访问密钥。');
    }
  });

  document.querySelector('#dismiss-key').addEventListener('click', () => {
    clearPendingCredential(sessionStorage);
    pending = null;
    credentialOutput.textContent = '';
    credentialPanel.hidden = true;
    dialog.close();
    location.reload();
  });

  for (const button of document.querySelectorAll('[data-key-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.keyAction;
      if (!confirm(action === 'revoke'
        ? '确定吊销此访问密钥并断开对应设备吗？'
        : '确定重置此设备绑定吗？重置后该设备需要重新绑定。')) return;
      clearNotice(pageNotice);
      setBusy(button, true);
      try {
        const { response, result } = await adminJson(`/admin/keys/${encodeURIComponent(button.dataset.keyId)}/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!response.ok && !result.retryable) throw new Error(errorText(result.error));
        location.reload();
      } catch (error) {
        setBusy(button, false);
        showNotice(pageNotice, `操作失败：${error.message}`);
      }
    });
  }
}

if (typeof document !== 'undefined') initialize();
