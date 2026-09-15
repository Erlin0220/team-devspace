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
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
    issued: '待绑定', provisioning: '配置中', active: '正常', suspended: '设备端已暂停',
    resetting: '重置中', revoked: '已吊销',
  })[key.state] ?? '未知';
}

function localTime(value, fallback = '—') {
  return value
    ? `<time class="local-time" datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>`
    : `<span class="muted">${escapeHtml(fallback)}</span>`;
}

function lifecycleTimes(key) {
  const rows = [`<span><b>创建</b>${localTime(key.createdAt)}</span>`];
  if (key.state === 'revoked') {
    rows.push(`<span><b>吊销</b>${localTime(key.revokedAt, '旧记录未记录')}</span>`);
    rows.push(`<span><b>清理完成</b>${key.cleanupPending ? '<span class="muted">等待清理</span>' : localTime(key.cleanupCompletedAt)}</span>`);
  } else if (key.updatedAt && key.updatedAt !== key.createdAt) {
    rows.push(`<span><b>最近变更</b>${localTime(key.updatedAt)}</span>`);
  }
  return `<div class="lifecycle-times">${rows.join('')}</div>`;
}

function eventText(value) {
  return ({ created: '创建密钥', revoked: '吊销密钥', revoked_cleanup_completed: '连接资源清理完成',
    reset: '重置设备绑定', deleted: '删除吊销记录' })[value] ?? value;
}

function renderAudit(events, unavailable = false) {
  if (unavailable) return `<section class="audit-section" aria-label="\u6700\u8fd1\u64cd\u4f5c\u8bb0\u5f55"><div class="audit-hint">\u6700\u8fd1\u64cd\u4f5c\u8bb0\u5f55\u6682\u65f6\u4e0d\u53ef\u7528\uff1b\u8bbf\u95ee\u5bc6\u94a5\u4e0e\u8bbe\u5907\u7ba1\u7406\u4e0d\u53d7\u5f71\u54cd\u3002</div></section>`;
  if (!events.length) return '';
  const rows = events.map(event => `<tr><td class="key-name">${escapeHtml(event.label)}</td>` +
    `<td>${escapeHtml(eventText(event.event))}</td>` +
    `<td><code title="${escapeHtml(event.keyId)}">${escapeHtml(`${String(event.keyId).slice(0, 8)}…`)}</code></td>` +
    `<td>${localTime(event.occurredAt)}</td></tr>`).join('');
  return `<details class="audit-section"><summary>最近操作记录（${events.length}）</summary>` +
    `<div class="audit-hint">只保留密钥生命周期元数据，不保存 Access Key、密钥哈希、设备密钥或项目数据。最多显示最近 100 条。</div>` +
    `<div class="table-wrap"><table><thead><tr><th>名称</th><th>操作</th><th>Key ID</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function renderKeyRow(key) {
  const id = escapeHtml(key.id);
  const label = escapeHtml(key.label);
  const state = escapeHtml(key.state);
  const fullDevice = key.deviceId ? escapeHtml(key.deviceId) : '';
  const device = key.deviceId ? `${String(key.deviceId).slice(0, 8)}…` : '';
  const status = `${stateText(key)}${key.cleanupPending ? ' · 待清理' : ''}`;
  const report = key.updateReport;
  const updateText = report && ({ installed: '安装完成', restart_required: '等待重启确认', failed: '安装未完成',
    deferred: '更新已延后', awaiting_authorization: '等待系统授权', installer_pending: '安装器结果待确认' })[report.status];
  const updateSnapshot = updateText ? `<br><small title="低频更新快照，不代表实时在线状态">${escapeHtml(report.targetVersion)} · ${updateText}` +
    `${key.versionReportedAt ? ` · <time class="local-time" datetime="${escapeHtml(key.versionReportedAt)}">${escapeHtml(key.versionReportedAt)}</time>` : ''}</small>` : '';
  const clientReport = key.versionReportedAt
    ? `<br><small title="客户端低频上报时间，不代表实时在线状态">最近客户端上报 · ${localTime(key.versionReportedAt)}</small>`
    : '';
  const buttons = [];
  if (key.bindingId && ['active', 'suspended'].includes(key.state)) {
    buttons.push(`<button type="button" class="secondary outline" data-key-action="reset" data-key-id="${id}" data-key-label="${label}">重置设备</button>`);
  }
  if (!['revoked', 'resetting'].includes(key.state)) {
    buttons.push(`<button type="button" class="danger-link" data-key-action="revoke" data-key-id="${id}" data-key-label="${label}">吊销</button>`);
  }
  if (key.state === 'revoked' && !key.cleanupPending) {
    buttons.push(`<button type="button" class="danger-link" data-key-action="delete" data-key-id="${id}" data-key-label="${label}">删除记录</button>`);
  }
  return `<tr><td class="key-name">${label}</td><td><span class="state state-${state}${key.cleanupPending ? ' state-cleanup' : ''}">${escapeHtml(status)}</span></td>` +
    `<td>${device ? `<code title="${fullDevice}">${escapeHtml(device)}</code><br><small>${key.clientVersion ? `v${escapeHtml(key.clientVersion)} · ${escapeHtml(key.clientPlatform)}` : '版本未上报；旧客户端需先手动安装一次新版'}</small>${clientReport}` : '<span class="muted">未绑定</span>'}</td>` +
    `<td>${lifecycleTimes(key)}${updateSnapshot}</td>` +
    `<td class="actions"><div class="action-buttons">${buttons.join(' ') || '—'}</div></td></tr>`;
}

function keyTable(rows, emptyText) {
  return `<div class="table-wrap"><table><thead><tr><th>名称</th><th>状态</th><th>设备 ID</th><th>生命周期</th><th>操作</th></tr></thead>` +
    `<tbody>${rows || `<tr class="empty-row"><td colspan="5">${escapeHtml(emptyText)}</td></tr>`}</tbody></table></div>`;
}

export function renderAdmin(keys, events = [], { auditUnavailable = false } = {}) {
  const activeKeys = keys.filter(key => key.state !== 'revoked' || key.cleanupPending);
  const revokedKeys = keys.filter(key => key.state === 'revoked' && !key.cleanupPending);
  const rows = activeKeys.map(renderKeyRow).join('');
  const revokedRows = revokedKeys.map(renderKeyRow).join('');
  const revokedSection = revokedKeys.length
    ? `<details class="revoked-section"><summary>已吊销历史（${revokedKeys.length}）</summary>` +
      `<div class="revoked-toolbar"><span>这些记录已完成连接资源清理。删除后名称可以重新用于新密钥。</span>` +
      `<button type="button" class="danger-link" data-key-action="purge" data-key-count="${revokedKeys.length}">清理全部</button></div>` +
      `${keyTable(revokedRows, '暂无已吊销记录')}</details>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Team DevSpace 管理后台</title><link rel="stylesheet" href="/admin/assets/pico.min.css">` +
    `<link rel="stylesheet" href="/admin/assets/admin.css">` +
    `<script type="module" src="/admin/assets/admin.js"></script></head><body><main class="container">` +
    `<header class="page-header"><div><h1>Team DevSpace 管理后台</h1><p>访问密钥与设备绑定管理</p></div>` +
    `<div class="header-actions"><button type="button" class="secondary" id="policy-edit" disabled>客户端版本策略</button>` +
    `<button type="button" id="show-create">创建访问密钥</button></div></header>` +
    `<p id="notice" class="notice" role="alert" hidden></p>` +
    `<section class="table-card" aria-label="访问密钥列表">${keyTable(rows, revokedKeys.length ? '暂无有效或待处理的访问密钥' : '暂无访问密钥')}</section>` +
    revokedSection +
    renderAudit(events, auditUnavailable) +
    `<dialog id="policy-dialog" aria-labelledby="policy-dialog-title"><article class="policy-dialog-card">` +
    `<header class="dialog-header"><div><h2 id="policy-dialog-title">编辑版本策略</h2>` +
    `<p>调整自动推广与最低支持版本，不会远程强制执行安装器。</p></div>` +
    `<button type="button" id="close-policy-dialog" class="icon-button" aria-label="关闭">×</button></header>` +
    `<p id="policy-dialog-notice" class="notice" role="alert" hidden></p>` +
    `<form id="policy-form"><fieldset id="policy-fields" disabled>` +
    `<div class="policy-editor-grid"><label>稳定版 stable<input id="policy-stable" readonly></label>` +
    `<label>自动推广 auto<select id="policy-auto"><option value="">暂停自动推广</option></select></label>` +
    `<label>最低支持版本<select id="policy-minimum"><option value="">不设置最低支持版本</option></select></label>` +
    `<label id="policy-deadline-field">生效时间<input id="policy-deadline" type="datetime-local"></label></div>` +
    `<p class="form-hint">自动推广与最低版本必须是已发布且具有独立签名的版本。调低推广版本不会降级已安装客户端。</p>` +
    `<footer class="dialog-actions"><button type="button" class="secondary" id="policy-cancel">取消</button><button id="policy-save" type="submit">保存策略</button></footer>` +
    `</fieldset></form></article></dialog>` +
    `<dialog id="create-dialog" aria-labelledby="dialog-title"><article><header class="dialog-header"><div><h2 id="dialog-title">创建访问密钥</h2>` +
    `<p>为员工或设备生成一个独立的连接密钥。</p></div><button type="button" id="close-dialog" class="icon-button" aria-label="关闭">×</button></header>` +
    `<p id="dialog-notice" class="notice" role="alert" hidden></p>` +
    `<section id="create-panel"><form id="create-key"><label>名称<input name="label" maxlength="100" autocomplete="off" placeholder="例如：张三-Windows" required>` +
    `<small>建议使用“人员-设备”格式，方便后续识别和吊销。</small></label><footer class="dialog-actions">` +
    `<button type="button" class="secondary" id="cancel-create">取消</button><button type="submit" id="create-submit">创建密钥</button></footer></form></section>` +
    `<section id="credential-panel" hidden><h3>访问密钥</h3><div class="credential-row"><code id="credential"></code>` +
    `<button type="button" id="copy-key" class="secondary">复制</button></div><p class="credential-hint">该密钥只显示一次，请保存后再关闭。</p>` +
    `<footer class="dialog-actions"><button type="button" class="secondary" id="retry-key" hidden>重试同步</button>` +
    `<button type="button" id="dismiss-key">我已保存并关闭</button></footer></section></article></dialog>` +
    `<dialog id="action-dialog" aria-labelledby="action-title"><article><header class="dialog-header"><div><h2 id="action-title">确认操作</h2>` +
    `<p id="action-description"></p></div><button type="button" id="close-action-dialog" class="icon-button" aria-label="关闭">×</button></header>` +
    `<p id="action-notice" class="notice" role="alert" hidden></p><footer class="dialog-actions">` +
    `<button type="button" class="secondary" id="cancel-action">取消</button><button type="button" class="danger" id="confirm-action">确认</button>` +
    `</footer></article></dialog></main></body></html>`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: headers('application/json; charset=utf-8') });
}

export async function adminWeb(request, env, service, updates) {
  if (new URL(request.url).origin !== new URL(env.PUBLIC_ORIGIN).origin) throw new AdminWebError(404, 'not_found');
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
    const [keys, audit] = await Promise.all([service.listKeys(), service.listKeyEvents(100)
      .then(events => ({ events, unavailable: false }), () => {
        console.warn(JSON.stringify({ event: 'admin_audit_unavailable' }));
        return { events: [], unavailable: true };
      })]);
    return new Response(renderAdmin(keys, audit.events, { auditUnavailable: audit.unavailable }),
      { headers: headers('text/html; charset=utf-8') });
  }
  if (pathname === '/admin/update-policy' && updates) {
    if (request.method === 'GET') return json(await updates.read());
    if (request.method === 'POST') {
      requireMutation(request, env);
      return json(await updates.save(await smallJson(request)));
    }
    throw new AdminWebError(405, 'method_not_allowed');
  }
  if (pathname === '/admin/downloads' && request.method === 'POST') {
    requireMutation(request, env);
    const body = await smallJson(request);
    if (Object.keys(body).length) throw new AdminWebError(400, 'invalid_download_request');
    throw new AdminWebError(410, 'download_commands_retired');
  }
  const createKey = pathname === '/admin/keys' && request.method === 'POST';
  const purgeRevoked = pathname === '/admin/keys/purge-revoked' && request.method === 'POST';
  const lifecycleMatch = /^\/admin\/keys\/([a-f0-9-]+)\/(revoke|reset|delete)$/.exec(pathname);
  const lifecycleAction = request.method === 'POST' && lifecycleMatch && UUID.test(lifecycleMatch[1]);
  if (!createKey && !purgeRevoked && !lifecycleAction) throw new AdminWebError(404, 'not_found');

  requireMutation(request, env);
  if (purgeRevoked) {
    const body = await smallJson(request);
    if (Object.keys(body).length) throw new AdminWebError(400, 'invalid_key_request');
    return json(await service.deleteAllRevokedKeys());
  }
  if (createKey) {
    const body = await smallJson(request);
    if (Object.keys(body).sort().join(',') !== 'id,keyHash,label' || !UUID.test(body.id ?? '') ||
        !HASH.test(body.keyHash ?? '') || typeof body.label !== 'string' || !body.label.trim() ||
        body.label.length > 100 || /[\x00-\x1f]/.test(body.label)) throw new AdminWebError(400, 'invalid_key_request');
    return json(await service.issueKey({ id: body.id, label: body.label.trim(), keyHash: body.keyHash }), 201);
  }
  if (lifecycleMatch[2] === 'delete') return json(await service.deleteRevokedKey(lifecycleMatch[1]));
  const result = lifecycleMatch[2] === 'revoke'
    ? await service.revokeKey(lifecycleMatch[1])
    : await service.resetDevice(lifecycleMatch[1]);
  return json({ ...result.key, cleanup: result.cleanup,
    ...(result.error ? { error: result.error, retryable: result.retryable } : {}) }, result.error ? 503 : 200);
}

export function adminWebError(error, requestId) {
  const known = error instanceof AdminWebError || error instanceof AdminServiceError;
  const status = known ? error.status : 503;
  const code = known ? error.code : 'service_unavailable';
  return json({ error: code, requestId }, status);
}
