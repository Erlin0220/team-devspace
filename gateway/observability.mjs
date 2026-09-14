// Metrics own traffic totals. Logs retain lifecycle outcomes and actionable
// failures, never credentials, paths, labels, request bodies or tool output.
const LIFECYCLE = new Set([
  'enroll', 'device_suspend', 'device_resume', 'device_release',
  'admin_issue_key', 'admin_revoke', 'admin_reset', 'admin_delete_revoked', 'admin_purge_revoked',
  'admin_web_issue', 'admin_web_revoke', 'admin_web_reset', 'admin_web_delete', 'admin_web_purge_revoked',
]);

export function requestLogLevel(operation, status, code) {
  if (status >= 500) return code === 'device_offline' ? 'warn' : 'error';
  // Public 404s and successful health/static/MCP traffic add no diagnostic value.
  if (status >= 400 && operation !== 'not_found') return 'warn';
  return LIFECYCLE.has(operation) ? 'info' : null;
}

export function logRequest({ requestId, operation, status, code, gatewayDurationMs }, logger = console) {
  const level = requestLogLevel(operation, status, code);
  if (!level) return;
  logger[level](JSON.stringify({ event: 'request', requestId, operation, status,
    ...(code ? { code } : {}), gatewayDurationMs }));
}
