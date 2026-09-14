import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdateReport, parseUpdateReport, validateUpdateReport } from '../client/update-report.mjs';
import { renderAdmin } from '../gateway/admin-web.mjs';

const policy = { auto: '0.2.6' };
test('inventory exposes only bounded status enums and distinguishes installer exit from a running version', () => {
  assert.deepEqual(buildUpdateReport('0.2.5', policy, { result: { version: '0.2.6', exitCode: 0 } }),
    { targetVersion: '0.2.6', status: 'restart_required', code: null });
  assert.deepEqual(buildUpdateReport('0.2.6', policy, { result: { version: '0.2.6', exitCode: 0 } }),
    { targetVersion: '0.2.6', status: 'installed', code: null });
  assert.equal(buildUpdateReport('0.2.5', policy, { result: { version: '0.2.4', exitCode: 1 } }), null);
  const report = buildUpdateReport('0.2.5', policy, { automatic: { version: '0.2.6', deferred: true,
    code: 'private-path-and-secret', message: 'never transmit this' } });
  assert.deepEqual(report, { targetVersion: '0.2.6', status: 'deferred', code: 'update_failed' });
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.throws(() => validateUpdateReport({ ...report, logs: 'private' }));
  assert.throws(() => validateUpdateReport({ ...report, status: 'arbitrary' }));
  assert.equal(parseUpdateReport('broken JSON'), null);
  assert.deepEqual(parseUpdateReport(JSON.stringify(report)), report);
});

test('stale completion cannot report success for a new attempt; withdrawn auto offers disappear', () => {
  const report = buildUpdateReport('0.2.5', policy, {
    attempt: { version: '0.2.6', attemptId: 'new' }, result: { version: '0.2.6', attemptId: 'old', exitCode: 0 },
  });
  assert.equal(report.status, 'installer_pending');
  const automatic = { version: '0.2.6', ready: true, requiresAuthorization: true };
  assert.equal(buildUpdateReport('0.2.5', policy, { automatic }).status, 'awaiting_authorization');
  assert.equal(buildUpdateReport('0.2.5', { auto: null }, { automatic }), null);
});

test('admin labels snapshot freshness instead of claiming real-time update health', () => {
  const html = renderAdmin([{ id: 'id', label: 'fixture', state: 'active', deviceId: 'device', bindingId: 'binding',
    clientVersion: '0.2.5', clientPlatform: 'win32-x64', versionReportedAt: '2026-09-14T15:00:00.000Z',
    updateReport: { targetVersion: '0.2.6', status: 'awaiting_authorization', code: null } }]);
  assert.ok(html.includes('等待系统授权'));
  assert.ok(html.includes('低频更新快照，不代表实时在线状态'));
  assert.ok(html.includes('2026-09-14T15:00:00.000Z'));
});
