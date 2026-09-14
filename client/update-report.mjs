import { compareVersions, UPDATE_VERSION } from './update-policy.mjs';

const statuses = new Set(['installed', 'restart_required', 'failed', 'deferred', 'awaiting_authorization', 'installer_pending']);
const codes = new Set([null, 'installer_failed', 'remote_work_active', 'local_operation_active', 'installer_pending', 'update_failed']);

// Fleet inventory is a small snapshot, not logs, progress streaming, or an
// authorization proof. Canonical serialization avoids writes for unchanged data.
export function validateUpdateReport(value) {
  if (value === null) return null;
  if (!value || Object.keys(value).sort().join() !== 'code,status,targetVersion' ||
      !UPDATE_VERSION.test(value.targetVersion ?? '') || !statuses.has(value.status) || !codes.has(value.code)) {
    throw new Error('Invalid update report');
  }
  return { targetVersion: value.targetVersion, status: value.status, code: value.code };
}

export function parseUpdateReport(value) {
  try { return validateUpdateReport(typeof value === 'string' ? JSON.parse(value) : value ?? null); }
  catch { return null; }
}

export function buildUpdateReport(currentVersion, policy, { attempt, result, automatic }) {
  const relevant = version => UPDATE_VERSION.test(version ?? '') && compareVersions(version, currentVersion) >= 0;
  const report = (targetVersion, status, code = null) => ({ targetVersion, status, code });
  const matchingResult = result && (!attempt || (result.version === attempt.version &&
    (!attempt.attemptId || attempt.attemptId === result.attemptId)));
  if (matchingResult && relevant(result.version) && Number.isInteger(result.exitCode)) {
    if (result.exitCode !== 0) return report(result.version, 'failed', 'installer_failed');
    if (result.version !== currentVersion) return report(result.version, 'restart_required');
  }
  if (relevant(attempt?.version) && !matchingResult) return report(attempt.version, 'installer_pending', 'installer_pending');
  if (automatic?.version === policy?.auto && relevant(automatic?.version) && automatic.version !== currentVersion) {
    if (automatic.requiresAuthorization && automatic.ready) return report(automatic.version, 'awaiting_authorization');
    if (automatic.deferred) return report(automatic.version, 'deferred', codes.has(automatic.code) ? automatic.code : 'update_failed');
  }
  return matchingResult && result.exitCode === 0 && result.version === currentVersion
    ? report(currentVersion, 'installed') : null;
}
