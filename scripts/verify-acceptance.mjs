import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import release from '../release.config.json' with { type: 'json' };
import { sha256File } from './build-utils.mjs';

const root = resolve('release', 'offline', release.version);
const expectedCommit = process.env.GITHUB_SHA;
const requireFinalWindows = process.env.TEAM_DEVSPACE_REQUIRE_FINAL_WINDOWS === '1';

for (const target of release.distribution.targets) {
  const path = join(root, target, 'acceptance.json');
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.schema, 1, `${target}: unsupported acceptance evidence schema`);
  assert.equal(evidence.passed, true, `${target}: acceptance did not pass`);
  assert.equal(evidence.release, release.version, `${target}: acceptance release mismatch`);
  assert.equal(evidence.target, target, `${target}: acceptance target mismatch`);
  if (expectedCommit) {
    assert.equal(evidence.commit, expectedCommit, `${target}: acceptance came from another commit`);
    assert.equal(evidence.sourceDirty, false, `${target}: acceptance was produced from a dirty source checkout`);
  }
  assert.equal(evidence.checks?.releaseLayout, true, `${target}: release layout was not accepted`);
  assert.equal(evidence.checks?.installerTransaction, true, `${target}: installer transaction was not accepted`);
  assert.equal(evidence.checks?.installedPayload, true, `${target}: extracted/installed payload contents were not accepted`);
  assert.equal(evidence.checks?.zeroResidue, true, `${target}: acceptance did not prove cleanup of its own lifecycle/install residue`);
  assert.ok(evidence.entrypoint?.name && /^[a-f0-9]{64}$/.test(evidence.entrypoint.sha256 ?? ''), `${target}: invalid accepted entrypoint identity`);
  const entrypoint = join(root, target, evidence.entrypoint.name);
  assert.equal(basename(entrypoint), evidence.entrypoint.name, `${target}: invalid accepted entrypoint path`);
  assert.equal(await sha256File(entrypoint), evidence.entrypoint.sha256, `${target}: published entrypoint differs from the accepted bytes`);

  if (target === 'win32-x64') {
    assert.equal(evidence.checks.trayProtocol, true, 'Windows native tray protocol was not accepted');
    assert.equal(evidence.checks.traySingleInstance, true, 'Windows tray single-instance invariant was not accepted');
    assert.equal(evidence.checks.nativeStartup, true, 'Windows Task Scheduler lifecycle was not accepted');
    if (requireFinalWindows) assert.equal(evidence.checks.finalEntrypointTransaction, true,
      'The signed Windows installer bytes were not exercised end-to-end on the isolated runner');
  } else if (target.startsWith('darwin-')) {
    assert.equal(evidence.checks.trayProtocol, true, 'macOS native tray protocol was not accepted');
    assert.equal(evidence.checks.traySingleInstance, true, 'macOS tray single-instance invariant was not accepted');
    assert.equal(evidence.checks.finalEntrypointTransaction, true, 'The final macOS PKG was not installed through the system installer');
    assert.equal(evidence.checks.nativeStartup, true, 'macOS installed LaunchAgent/runtime lifecycle was not accepted');
  } else if (target === 'linux-x64') {
    assert.equal(evidence.checks.nativeStartup, true, 'Linux systemd user lifecycle was not accepted');
    assert.equal(evidence.checks.finalEntrypointTransaction, true, 'The final Linux archive was not exercised');
  }
  console.log(JSON.stringify({ accepted: true, target, entrypoint: evidence.entrypoint.name }));
}
