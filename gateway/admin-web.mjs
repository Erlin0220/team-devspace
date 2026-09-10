import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AdminServiceError } from './admin-service.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export class AdminWebError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'AdminWebError';
    this.status = status;
    this.code = code;
  }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function headers(contentType) {
  return new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
}

const accessKeys = new Map();

async function requireAccess(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new AdminWebError(503, 'access_not_configured');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new AdminWebError(403, 'access_required');
  let keys = accessKeys.get(env.ACCESS_TEAM_DOMAIN);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    accessKeys.set(env.ACCESS_TEAM_DOMAIN, keys);
  }
  try {
    await jwtVerify(token, keys, { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
  } catch {
    throw new AdminWebError(403, 'access_required');
  }
}

function requireMutation(request, env) {
  const expected = new URL(env.PUBLIC_ORIGIN).origin;
  if (request.headers.get('Origin') !== expected || request.headers.get('Sec-Fetch-Site') !== 'same-origin') {
    throw new AdminWebError(403, 'cross_site_request_rejected');
  }
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new AdminWebError(415, 'json_required');
  }
}

async function smallJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AdminWebError(400, 'invalid_json');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) { await reader.cancel(); throw new AdminWebError(413, 'body_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AdminWebError(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminWebError(400, 'invalid_body');
  return value;
}

function stateText(key) {
  return ({
    issued: '已签发', provisioning: '配置中', active: '正常', suspended: '已暂停',
    resetting: '重置中', revoked: '已吊销',
  })[key.state] ?? '未知';
}

export function renderAdmin(keys) {
  const rows = keys.map(key => {
    const id = escapeHtml(key.id);
    const fullDevice = key.deviceId ? escapeHtml(key.deviceId) : '';
    const device = key.deviceId ? `${String(key.deviceId).slice(0, 8)}…` : '—';
    const actions = key.state === 'revoked' ? '—' : [
      key.bindingId ? `<button type="button" class="secondary outline" data-key-action="reset" data-key-id="${id}">重置设备</button>` : '',
      `<button type="button" class="contrast outline" data-key-action="revoke" data-key-id="${id}">吊销</button>`,
    ].filter(Boolean).join(' ');
    return `<tr><td class="key-name">${escapeHtml(key.label)}</td><td><span class="state state-${escapeHtml(key.state)}">${stateText(key)}</span></td>` +
      `<td><code${fullDevice ? ` title="${fullDevice}"` : ''}>${escapeHtml(device)}</code></td>` +
      `<td><time class="local-time" datetime="${escapeHtml(key.updatedAt ?? '')}">${escapeHtml(key.updatedAt ?? '—')}</time></td>` +
      `<td>${key.cleanupPending ? '<span class="cleanup-pending">待清理</span>' : '—'}</td><td class="actions">${actions}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Team DevSpace 管理后台</title><link rel="stylesheet" href="/admin/assets/pico.min.css">` +
    `<link rel="stylesheet" href="/admin/assets/admin.css">` +
    `<script type="module" src="/admin/assets/admin.js"></script></head><body><main class="container">` +
    `<header class="page-header"><div><h1>Team DevSpace 管理后台</h1><p>访问密钥与设备绑定管理</p></div>` +
    `<button type="button" id="show-create">创建访问密钥</button></header>` +
    `<p id="notice" class="notice" role="alert" hidden></p>` +
    `<section class="table-card" aria-label="访问密钥列表"><div class="table-wrap"><table><thead><tr><th>名称</th><th>状态</th>` +
    `<th>设备</th><th>更新时间</th><th>清理状态</th><th>操作</th></tr></thead><tbody>${rows || '<tr class="empty-row"><td colspan="6">暂无访问密钥</td></tr>'}</tbody></table></div></section>` +
    `<dialog id="create-dialog"><article><header class="dialog-header"><div><h2 id="dialog-title">创建访问密钥</h2>` +
    `<p>为员工或设备生成一个独立的连接密钥。</p></div><button type="button" id="close-dialog" class="icon-button" aria-label="关闭">×</button></header>` +
    `<p id="dialog-notice" class="notice" role="alert" hidden></p>` +
    `<section id="create-panel"><form id="create-key"><label>名称<input name="label" maxlength="100" autocomplete="off" placeholder="例如：张三-Windows" required>` +
    `<small>建议使用“人员-设备”格式，方便后续识别和吊销。</small></label><footer class="dialog-actions">` +
    `<button type="button" class="secondary" id="cancel-create">取消</button><button type="submit" id="create-submit">创建密钥</button></footer></form></section>` +
    `<section id="credential-panel" hidden><h3>访问密钥</h3><div class="credential-row"><code id="credential"></code>` +
    `<button type="button" id="copy-key" class="secondary">复制</button></div><p class="credential-hint">该密钥只显示一次，请保存后再关闭。</p>` +
    `<footer class="dialog-actions"><button type="button" class="secondary" id="retry-key" hidden>重试同步</button>` +
    `<button type="button" id="dismiss-key">我已保存并关闭</button></footer></section></article></dialog>` +
    `</main></body></html>`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: headers('application/json; charset=utf-8') });
}

export async function adminWeb(request, env, service) {
  await requireAccess(request, env);
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith('/admin/assets/')) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new AdminWebError(405, 'method_not_allowed');
    const assetUrl = new URL(request.url);
    assetUrl.pathname = pathname.replace('/admin/assets/', '/admin/');
    const assetRequest = new Request(assetUrl, { method: request.method, headers: request.headers });
    const asset = await env.ASSETS.fetch(assetRequest);
    const output = headers(asset.headers.get('Content-Type') ?? 'application/octet-stream');
    return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers: output });
  }
  if ((pathname === '/admin' || pathname === '/admin/') && request.method === 'GET') {
    return new Response(renderAdmin(await service.listKeys()), { headers: headers('text/html; charset=utf-8') });
  }
  const createKey = pathname === '/admin/keys' && request.method === 'POST';
  const lifecycleMatch = /^\/admin\/keys\/([a-f0-9-]+)\/(revoke|reset)$/.exec(pathname);
  const lifecycleAction = request.method === 'POST' && lifecycleMatch && UUID.test(lifecycleMatch[1]);
  if (!createKey && !lifecycleAction) throw new AdminWebError(404, 'not_found');

  requireMutation(request, env);
  if (createKey) {
    const body = await smallJson(request);
    if (Object.keys(body).sort().join(',') !== 'id,keyHash,label' || !UUID.test(body.id ?? '') ||
        !HASH.test(body.keyHash ?? '') || typeof body.label !== 'string' || !body.label.trim() ||
        body.label.length > 100 || /[\x00-\x1f]/.test(body.label)) throw new AdminWebError(400, 'invalid_key_request');
    return json(await service.issueKey({ id: body.id, label: body.label.trim(), keyHash: body.keyHash }), 201);
  }
  const result = lifecycleMatch[2] === 'revoke'
    ? await service.revokeKey(lifecycleMatch[1])
    : await service.resetDevice(lifecycleMatch[1]);
  return json({ ...result.key, cleanup: result.cleanup,
    ...(result.error ? { error: result.error, retryable: result.retryable } : {}) }, result.error ? 503 : 200);
}

export function adminWebError(error, requestId) {
  const status = error instanceof AdminWebError || error instanceof AdminServiceError ? error.status : 503;
  const code = error instanceof AdminWebError || error instanceof AdminServiceError ? error.code : 'service_unavailable';
  return json({ error: code, requestId }, status);
}
