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
  if (!response.ok) throw new Error(errorText(result.error));
  return result;
}

function initialize() {
  const createPanel = document.querySelector('#create-panel');
  const credentialPanel = document.querySelector('#credential-panel');
  const credentialOutput = document.querySelector('#credential');
  const notice = document.querySelector('#notice');
  const showNotice = message => {
    notice.textContent = message;
    notice.hidden = false;
  };
  const showCredential = credential => {
    credentialOutput.textContent = credential.accessKey;
    credentialPanel.hidden = false;
    createPanel.hidden = true;
  };
  let pending = loadPendingCredential(sessionStorage);
  if (pending) {
    showCredential(pending);
    showNotice('检测到上次未完成的访问密钥，请使用同一密钥重试，不要重新生成。');
  }
  document.querySelector('#show-create').addEventListener('click', () => {
    if (pending) { showCredential(pending); return; }
    createPanel.hidden = false;
  });
  document.querySelector('#cancel-create').addEventListener('click', () => { createPanel.hidden = true; });
  document.querySelector('#create-key').addEventListener('submit', async event => {
    event.preventDefault();
    const label = new FormData(event.currentTarget).get('label')?.trim();
    if (!label) return;
    try {
      pending ??= await createPendingCredential(label);
      savePendingCredential(sessionStorage, pending);
      await issueCredential(pending);
      showCredential(pending);
      notice.hidden = true;
    } catch (error) { showNotice(`创建失败：${error.message}。再次重试时会继续使用同一个待创建密钥。`); }
  });
  document.querySelector('#retry-key').addEventListener('click', async () => {
    if (!pending) return;
    try {
      await issueCredential(pending);
      notice.hidden = true;
    } catch (error) { showNotice(`重试失败：${error.message}`); }
  });
  document.querySelector('#copy-key').addEventListener('click', async () => {
    await navigator.clipboard.writeText(credentialOutput.textContent);
    showNotice('访问密钥已复制。');
  });
  document.querySelector('#dismiss-key').addEventListener('click', () => {
    clearPendingCredential(sessionStorage);
    pending = null;
    credentialOutput.textContent = '';
    credentialPanel.hidden = true;
    location.reload();
  });
  for (const button of document.querySelectorAll('[data-key-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.keyAction;
      if (!confirm(action === 'revoke'
        ? '确定吊销此访问密钥并断开对应设备吗？'
        : '确定重置此设备绑定吗？重置后该设备需要重新绑定。')) return;
      button.disabled = true;
      try {
        const { response, result } = await adminJson(`/admin/keys/${encodeURIComponent(button.dataset.keyId)}/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!response.ok && !result.retryable) throw new Error(errorText(result.error));
        location.reload();
      } catch (error) {
        button.disabled = false;
        showNotice(`操作失败：${error.message}`);
      }
    });
  }
}

if (typeof document !== 'undefined') initialize();
