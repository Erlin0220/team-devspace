const PENDING_KEY = 'team-devspace.pending-access-key';
const FLASH_KEY = 'team-devspace.admin-flash';

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

export function confirmMinimumPolicyChange(previousMinimum, nextMinimum, ask = globalThis.confirm) {
  if (previousMinimum && !nextMinimum) {
    return ask('本次保存会解除最低支持版本限制，旧客户端将不再被该门槛阻止。暂停自动推广不会保留现有最低版本限制，确认同时解除吗？');
  }
  return !nextMinimum || ask('到期后，低于最低支持版本或尚未上报版本的设备将不能开始新的远程工作。确认已通知员工并保留升级恢复入口吗？');
}

function errorText(code) {
  return ({
    key_label_or_id_conflict: '名称或密钥 ID 已存在',
    deleted_key_id_cannot_be_reused: '该密钥 ID 已被永久删除，必须生成新的访问密钥',
    key_not_found: '未找到该访问密钥',
    revoked_key_cannot_be_reset: '已吊销的密钥不能重置设备',
    revoked_key_not_ready_for_delete: '只有已吊销且云端资源已清理完成的记录才能删除',
    connectivity_cleanup_pending: '远程连接已禁用，但云端清理尚未完成',
    access_lifecycle_changed: '访问密钥状态已发生变化，请刷新页面后重试',
    invalid_key_request: '访问密钥请求无效',
    request_failed: '请求失败',
    invalid_update_policy: '版本策略无效：最低支持版本须先批准自动推广，并设置明确的生效时间',
    update_policy_changed: '另一位管理员已更新策略，请刷新后重新确认',
    update_release_not_verified: '该版本尚未发布完整的签名验收产物，不能批准推广',
    update_publication_in_progress: '版本正在发布或清理，请在发布完成后修改策略',
  })[code] ?? code ?? '未知错误';
}

export async function adminJson(path, options, { timeout = 30000, request = globalThis.fetch } = {}) {
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await request(path, { ...options, redirect: 'manual', signal });
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403) {
      throw new Error('管理员登录已过期，请刷新页面后重新登录。');
    }
    if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
      throw new Error('管理服务返回了异常响应，请刷新页面后重新登录。');
    }
    return { response, result: await response.json() };
  } catch (error) {
    if (signal.aborted) throw new Error('请求超时，操作结果尚未确认，请重试同步或刷新检查状态。');
    throw error;
  }
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
  const createDialog = document.querySelector('#create-dialog');
  const actionDialog = document.querySelector('#action-dialog');
  const createPanel = document.querySelector('#create-panel');
  const credentialPanel = document.querySelector('#credential-panel');
  const credentialOutput = document.querySelector('#credential');
  const pageNotice = document.querySelector('#notice');
  const dialogNotice = document.querySelector('#dialog-notice');
  const actionNotice = document.querySelector('#action-notice');
  const dialogTitle = document.querySelector('#dialog-title');
  const actionTitle = document.querySelector('#action-title');
  const actionDescription = document.querySelector('#action-description');
  const createForm = document.querySelector('#create-key');
  const createSubmit = document.querySelector('#create-submit');
  const retryButton = document.querySelector('#retry-key');
  const copyButton = document.querySelector('#copy-key');
  const confirmAction = document.querySelector('#confirm-action');
  const dismissKey = document.querySelector('#dismiss-key');
  let credentialBusy = false;

  const showNotice = (target, message) => {
    target.textContent = message;
    target.hidden = false;
  };
  const clearNotice = target => {
    target.textContent = '';
    target.hidden = true;
  };
  const setBusy = (button, busy, busyText = '处理中…') => {
    if (busy) {
      button.dataset.idleText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      if (button.dataset.idleText) button.textContent = button.dataset.idleText;
      delete button.dataset.idleText;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };
  const openCreateDialog = () => {
    if (!createDialog.open) createDialog.showModal();
  };
  const showCreateForm = () => {
    dialogTitle.textContent = '创建访问密钥';
    credentialPanel.hidden = true;
    createPanel.hidden = false;
    retryButton.hidden = true;
    clearNotice(dialogNotice);
    createForm.reset();
    openCreateDialog();
    requestAnimationFrame(() => createForm.elements.label?.focus());
  };
  const showCredential = credential => {
    const needsRetry = credential.confirmed !== true;
    dismissKey.disabled = needsRetry;
    copyButton.disabled = needsRetry;
    dialogTitle.textContent = needsRetry ? '继续创建访问密钥' : '访问密钥已创建';
    credentialOutput.textContent = credential.accessKey;
    credentialPanel.hidden = false;
    createPanel.hidden = true;
    retryButton.hidden = !needsRetry;
    openCreateDialog();
  };
  const flash = message => sessionStorage.setItem(FLASH_KEY, message);

  for (const time of document.querySelectorAll('.local-time')) {
    const date = new Date(time.dateTime);
    if (!Number.isNaN(date.getTime())) {
      time.title = time.dateTime;
      time.textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }
  }

  const policyForm = document.querySelector('#policy-form');
  if (policyForm) {
    const policyDialog = document.querySelector('#policy-dialog');
    const policyDialogNotice = document.querySelector('#policy-dialog-notice');
    const fields = document.querySelector('#policy-fields');
    const editButton = document.querySelector('#policy-edit');
    const cancelButton = document.querySelector('#policy-cancel');
    const closeButton = document.querySelector('#close-policy-dialog');
    const autoSelect = document.querySelector('#policy-auto');
    const minimumSelect = document.querySelector('#policy-minimum');
    const deadlineField = document.querySelector('#policy-deadline-field');
    let policy;
    let versions = [];
    const closePolicyEditor = () => {
      if (policyDialog.open) policyDialog.close();
      clearNotice(policyDialogNotice);
    };
    const openPolicyEditor = () => {
      if (!policy || fields.disabled) return;
      renderPolicy(policy);
      clearNotice(policyDialogNotice);
      if (!policyDialog.open) policyDialog.showModal();
      requestAnimationFrame(() => document.querySelector('#policy-auto').focus());
    };
    const renderPolicy = value => {
      policy = value;
      document.querySelector('#policy-stable').value = value.stable;
      versions = [...new Set((Array.isArray(value.selectableVersions) ? value.selectableVersions :
        [value.stable, value.auto, value.minimumSupported]).filter(Boolean))];
      autoSelect.replaceChildren(new Option('暂停自动推广', ''));
      for (const version of versions) autoSelect.add(new Option(version, version));
      autoSelect.value = value.auto ?? '';
      const renderMinimumOptions = selected => {
        const previous = selected ?? minimumSelect.value;
        minimumSelect.replaceChildren(new Option('不设置最低支持版本', ''));
        if (autoSelect.value) {
          for (const version of versions) {
            if (compareVersionText(version, autoSelect.value) <= 0) minimumSelect.add(new Option(version, version));
          }
        }
        minimumSelect.disabled = !autoSelect.value;
        minimumSelect.value = [...minimumSelect.options].some(option => option.value === previous) ? previous : '';
        deadlineField.hidden = !minimumSelect.value;
        if (!minimumSelect.value) document.querySelector('#policy-deadline').value = '';
      };
      renderMinimumOptions(value.minimumSupported ?? '');
      const deadline = value.enforceAfter ? new Date(value.enforceAfter) : null;
      document.querySelector('#policy-deadline').value = deadline
        ? new Date(deadline.getTime() - deadline.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
      deadlineField.hidden = !minimumSelect.value;
      fields.disabled = false;
      editButton.disabled = false;
    };
    const compareVersionText = (left, right) => {
      const a = left.split('.').map(Number), b = right.split('.').map(Number);
      for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
      return 0;
    };
    const refreshMinimumOptions = () => {
      const selected = minimumSelect.value;
      minimumSelect.replaceChildren(new Option('不设置最低支持版本', ''));
      if (autoSelect.value) {
        for (const version of versions) {
          if (compareVersionText(version, autoSelect.value) <= 0) minimumSelect.add(new Option(version, version));
        }
      }
      minimumSelect.disabled = !autoSelect.value;
      minimumSelect.value = [...minimumSelect.options].some(option => option.value === selected) ? selected : '';
      deadlineField.hidden = !minimumSelect.value;
      if (!minimumSelect.value) document.querySelector('#policy-deadline').value = '';
    };
    autoSelect.addEventListener('change', refreshMinimumOptions);
    minimumSelect.addEventListener('change', () => {
      deadlineField.hidden = !minimumSelect.value;
      if (!minimumSelect.value) document.querySelector('#policy-deadline').value = '';
    });
    editButton.addEventListener('click', openPolicyEditor);
    cancelButton.addEventListener('click', () => {
      if (policy) renderPolicy(policy);
      closePolicyEditor();
    });
    closeButton.addEventListener('click', closePolicyEditor);
    policyDialog.addEventListener('click', event => {
      if (event.target === policyDialog) closePolicyEditor();
    });
    void adminJson('/admin/update-policy', { method: 'GET' }).then(({ response, result }) => {
      if (!response.ok) throw new Error(errorText(result.error));
      renderPolicy(result);
    }).catch(error => showNotice(pageNotice, `无法读取版本策略：${error.message}。密钥管理不受影响。`));
    policyForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!policy || fields.disabled) return;
      const minimumSupported = minimumSelect.value || null;
      const date = document.querySelector('#policy-deadline').value;
      if (minimumSupported && !date) { showNotice(policyDialogNotice, '请设置最低版本生效时间，为员工留出更新时间。'); return; }
      if (!confirmMinimumPolicyChange(policy.minimumSupported, minimumSupported)) return;
      fields.disabled = true;
      showNotice(policyDialogNotice, '正在验证签名发布产物并保存策略…');
      try {
        const { response, result } = await adminJson('/admin/update-policy', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            revision: policy.revision, auto: autoSelect.value || null,
            minimumSupported, enforceAfter: minimumSupported ? new Date(date).toISOString() : null,
          }) });
        if (!response.ok) throw new Error(errorText(result.error));
        renderPolicy({ ...result, selectableVersions: versions });
        closePolicyEditor();
        showNotice(pageNotice, '版本策略已保存；不会远程执行安装器或降级已安装客户端。');
      } catch (error) { showNotice(policyDialogNotice, `保存未确认：${error.message}。请刷新核对后再操作。`); }
      finally { fields.disabled = false; }
    });
  }

  const previousFlash = sessionStorage.getItem(FLASH_KEY);
  if (previousFlash) {
    sessionStorage.removeItem(FLASH_KEY);
    showNotice(pageNotice, previousFlash);
  }

  let pending = loadPendingCredential(sessionStorage);
  if (pending) {
    showCredential(pending);
    showNotice(dialogNotice, pending.confirmed
      ? '该访问密钥已创建，请保存后再确认关闭。'
      : '上次创建结果尚未确认，请使用同一密钥重试，不要重新生成或分发。');
  }

  const showCreate = () => {
    if (credentialBusy) return;
    if (pending) {
      showCredential(pending);
      showNotice(dialogNotice, pending.confirmed
        ? '该访问密钥已创建，请保存后再确认关闭。'
        : '创建结果尚未确认，请先重试同步，不要分发该密钥。');
      return;
    }
    showCreateForm();
  };
  document.querySelector('#show-create').addEventListener('click', showCreate);
  const closeCreateDialog = () => { if (!credentialBusy) createDialog.close(); };
  document.querySelector('#close-dialog').addEventListener('click', closeCreateDialog);
  document.querySelector('#cancel-create').addEventListener('click', closeCreateDialog);
  createDialog.addEventListener('click', event => {
    if (event.target === createDialog) closeCreateDialog();
  });
  createDialog.addEventListener('cancel', event => {
    if (credentialBusy) event.preventDefault();
  });

  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (credentialBusy) return;
    const label = new FormData(event.currentTarget).get('label')?.trim();
    if (!label) return;
    credentialBusy = true;
    clearNotice(dialogNotice);
    setBusy(createSubmit, true, '创建中…');
    try {
      pending ??= await createPendingCredential(label);
      savePendingCredential(sessionStorage, pending);
      await issueCredential(pending);
      pending.confirmed = true;
      savePendingCredential(sessionStorage, pending);
      showCredential(pending);
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
        if (pending) showCredential(pending);
        showNotice(dialogNotice, `创建失败：${error.message}。再次重试时会继续使用同一个密钥。`);
      }
    } finally {
      credentialBusy = false;
      setBusy(createSubmit, false);
    }
  });

  retryButton.addEventListener('click', async () => {
    if (!pending || credentialBusy) return;
    credentialBusy = true;
    clearNotice(dialogNotice);
    setBusy(retryButton, true, '重试中…');
    try {
      await issueCredential(pending);
      pending.confirmed = true;
      savePendingCredential(sessionStorage, pending);
      showCredential(pending);
    } catch (error) {
      showNotice(dialogNotice, `重试失败：${error.message}`);
    } finally {
      credentialBusy = false;
      setBusy(retryButton, false);
    }
  });

  let copyTimer;
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(credentialOutput.textContent);
      clearNotice(dialogNotice);
      clearTimeout(copyTimer);
      copyButton.textContent = '已复制';
      copyTimer = setTimeout(() => { copyButton.textContent = '复制'; }, 1200);
    } catch {
      showNotice(dialogNotice, '复制失败，请手动选择并复制访问密钥。');
    }
  });

  dismissKey.addEventListener('click', () => {
    if (credentialBusy || pending?.confirmed !== true) {
      showNotice(dialogNotice, '创建结果尚未确认，请先重试同步。');
      return;
    }
    clearPendingCredential(sessionStorage);
    pending = null;
    credentialOutput.textContent = '';
    credentialPanel.hidden = true;
    createDialog.close();
    flash('访问密钥已创建。');
    location.reload();
  });

  let actionContext = null;
  const closeActionDialog = () => {
    if (actionDialog.open && !confirmAction.disabled) actionDialog.close();
  };
  document.querySelector('#close-action-dialog').addEventListener('click', closeActionDialog);
  document.querySelector('#cancel-action').addEventListener('click', closeActionDialog);
  actionDialog.addEventListener('click', event => {
    if (event.target === actionDialog) closeActionDialog();
  });
  actionDialog.addEventListener('cancel', event => {
    if (confirmAction.disabled) event.preventDefault();
  });

  for (const button of document.querySelectorAll('[data-key-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.keyAction;
      const label = button.dataset.keyLabel || '该访问密钥';
      actionContext = { action, id: button.dataset.keyId, label };
      clearNotice(actionNotice);
      if (action === 'revoke') {
        actionTitle.textContent = '吊销访问密钥';
        actionDescription.textContent = `吊销后，“${label}”将立即失效，当前设备无法继续连接。此操作不可恢复。`;
        confirmAction.textContent = '吊销密钥';
        confirmAction.classList.add('danger');
      } else if (action === 'delete') {
        actionTitle.textContent = '删除吊销记录';
        actionDescription.textContent = `永久删除“${label}”的已吊销记录。连接资源已经清理完成；删除后这个名称可以重新用于新密钥。`;
        confirmAction.textContent = '删除记录';
        confirmAction.classList.add('danger');
      } else if (action === 'purge') {
        const count = Number(button.dataset.keyCount ?? 0);
        actionTitle.textContent = '清理全部吊销记录';
        actionDescription.textContent = `永久删除 ${count} 条已吊销且已完成资源清理的历史记录。删除后这些名称可以重新使用。`;
        confirmAction.textContent = '清理全部';
        confirmAction.classList.add('danger');
      } else {
        actionTitle.textContent = '重置设备绑定';
        actionDescription.textContent = `将解除“${label}”当前设备的绑定并清理对应连接资源。访问密钥不会被吊销，可用于重新绑定设备。`;
        confirmAction.textContent = '确认重置';
        confirmAction.classList.remove('danger');
      }
      actionDialog.showModal();
    });
  }

  confirmAction.addEventListener('click', async () => {
    if (!actionContext) return;
    const { action, id } = actionContext;
    clearNotice(pageNotice);
    clearNotice(actionNotice);
    setBusy(confirmAction, true, action === 'revoke' ? '吊销中…'
      : action === 'delete' ? '删除中…' : action === 'purge' ? '清理中…' : '重置中…');
    try {
      const path = action === 'purge' ? '/admin/keys/purge-revoked' : `/admin/keys/${encodeURIComponent(id)}/${action}`;
      const { response, result } = await adminJson(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok && !result.retryable) throw new Error(errorText(result.error));
      if (action === 'delete') {
        flash('已吊销记录已删除，该名称现在可以重新用于新密钥。');
      } else if (action === 'purge') {
        flash(`已清理 ${result.deleted ?? 0} 条吊销历史记录。`);
      } else if (result.retryable) {
        flash(action === 'revoke'
          ? '访问密钥已吊销，云端连接资源暂未清理完成，系统会自动继续清理。'
          : '设备绑定已进入重置，云端连接资源暂未清理完成，系统会自动继续清理。');
      } else {
        flash(action === 'revoke' ? '访问密钥已吊销。' : '设备绑定已重置，可使用原访问密钥重新绑定。');
      }
      location.reload();
    } catch (error) {
      setBusy(confirmAction, false);
      showNotice(actionNotice, `操作失败：${error.message}`);
    }
  });
}

if (typeof document !== 'undefined') initialize();
