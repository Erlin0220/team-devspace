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

async function issueCredential(credential) {
  const response = await fetch('/admin/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentialRequest(credential)),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'request_failed');
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
    showNotice('A pending credential was recovered. Retry with the same key; do not generate another.');
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
    } catch (error) { showNotice(`Creation failed: ${error.message}. The same pending key will be reused.`); }
  });
  document.querySelector('#retry-key').addEventListener('click', async () => {
    if (!pending) return;
    try {
      await issueCredential(pending);
      notice.hidden = true;
    } catch (error) { showNotice(`Retry failed: ${error.message}`); }
  });
  document.querySelector('#copy-key').addEventListener('click', async () => {
    await navigator.clipboard.writeText(credentialOutput.textContent);
    showNotice('Access Key copied.');
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
        ? 'Revoke this Access Key and disconnect its Device?'
        : 'Reset this Device Binding and require a new Enrollment?')) return;
      button.disabled = true;
      try {
        const response = await fetch(`/admin/keys/${encodeURIComponent(button.dataset.keyId)}/${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const result = await response.json();
        if (!response.ok && !result.retryable) throw new Error(result.error ?? 'request_failed');
        location.reload();
      } catch (error) {
        button.disabled = false;
        showNotice(`Action failed: ${error.message}`);
      }
    });
  }
}

if (typeof document !== 'undefined') initialize();
