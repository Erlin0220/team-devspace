import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
async function shell(t, code) {
  const cwd = await mkdtemp(join(tmpdir(), 'tds-unix-lock-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return exec('bash', ['-c', `set -eu\n${code}`], {
    cwd, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' },
  });
}

const script = await readFile('platform/unix/bootstrap.sh', 'utf8');

test('Unix distribution root is explicitly owned and uninstall removes only Team DevSpace paths', () => {
  assert.match(script, /OWNER_MARKER=.*\.team-devspace-distribution/);
  assert.match(script, /assert_distribution_root/);
  assert.match(script, /remove_distribution_payload/);
  assert.doesNotMatch(script, /rm -rf "\$ROOT"/,
    'Uninstall must never recursively delete an arbitrary caller-selected distribution root');
});

test('Unix installer reclaims only a stale lock whose recorded PID is no longer alive', () => {
  assert.match(script, /kill -0 "\$owner_pid"/);
  assert.match(script, /Reclaiming stale installer lock/);
  assert.match(script, /missing or invalid owner PID/,
    'A lock without trustworthy ownership metadata must remain fail-closed');
});

test('concurrent Unix stale-lock recovery cannot steal the newly acquired installer lock', async t => {
  const lock = script.slice(script.indexOf('acquire_install_lock()'), script.indexOf('\nacquire_install_lock || exit 1'));
  const { stdout } = await shell(t, `
LOCK="$PWD/install.lock"
mkdir "$LOCK"
printf '2147483646\\n' > "$LOCK/pid"
ps() {
  if [ "\${RECLAIMER:-first}" = second ]; then
    touch second-checked-dead-owner
    while [ ! -f release-second ]; do sleep 0.02; done
  fi
  return 1
}
${lock}
(
  RECLAIMER=second
  if acquire_install_lock; then printf stolen > result; else printf rejected > result; fi
) &
second=$!
while [ ! -f second-checked-dead-owner ]; do sleep 0.02; done
acquire_install_lock
touch release-second
wait "$second"
test "$(cat result)" = rejected
test "$(cat "$LOCK/pid")" = "$$"
printf protected
`);
  assert.equal(stdout, 'protected');
});

test('Unix installer cleanup never removes a lock now owned by another installer', async t => {
  const cleanup = script.slice(script.indexOf("components_file=''"), script.indexOf('\ntrap cleanup EXIT'));
  const { stdout } = await shell(t, `
LOCK="$PWD/install.lock"
mkdir "$LOCK"
printf '2147483646\\n' > "$LOCK/pid"
${cleanup}
cleanup
test -f "$LOCK/pid"
printf retained
`);
  assert.equal(stdout, 'retained');
});

test('macOS repair stops damaged installed code through the verified replacement client', async t => {
  const stopStart = script.lastIndexOf('current=$(active_path || true)');
  const stop = script.slice(stopStart, script.indexOf('\ncase "$SETUP" in', stopStart));
  const { stdout } = await shell(t, `
TARGET=darwin-arm64
STATE_HOME="$PWD/state"
candidate="$PWD/verified-candidate"
mkdir -p "$STATE_HOME" "$candidate"
printf '{}' > "$STATE_HOME/state.json"
active_path() { printf '%s/old-broken-version' "$PWD"; }
invoke_client() { [ "$1" = "$candidate" ] && [ "$2" = stop ]; }
${stop}
test -d "$candidate"
printf repairable
`);
  assert.equal(stdout, 'repairable');
});

test('WSL source synchronization refuses home, unknown directories and foreign repositories without deleting them', async t => {
  const helper = (await readFile('scripts/linux-wsl.ps1', 'utf8')).replaceAll('\r\n', '\n');
  const guard = helper.slice(helper.indexOf('# rsync --delete'), helper.indexOf('# Keep Linux-native dependencies'));
  for (const setup of [
    'WORK="$HOME"',
    'WORK="$PWD/foreign"; mkdir "$WORK"',
    'WORK="$PWD/foreign"; git init -q "$WORK"; git -C "$WORK" remote add origin "$PWD/another-source"',
  ]) {
    const { stdout } = await shell(t, `
export HOME="$PWD/home"
SOURCE="$PWD/source"
mkdir -p "$HOME" "$SOURCE"
${setup}
printf retained > "$WORK/sentinel"
if ( ${guard} ); then exit 9; fi
test "$(cat "$WORK/sentinel")" = retained
printf protected
`);
    assert.equal(stdout, 'protected');
  }
});

test('WSL mirror restores Git modes and EOLs without hiding edited source', { skip: process.platform === 'win32' }, async t => {
  const helper = (await readFile('scripts/linux-wsl.ps1', 'utf8')).replaceAll('\r\n', '\n');
  const normalization = helper.slice(helper.indexOf('# DrvFS synthesizes'), helper.indexOf('\nexpected_node='));
  const { stdout } = await shell(t, `
git init -q
git config core.fileMode true
printf original > readme.txt
printf '#!/bin/sh\\nexit 0\\n' > run.sh
printf '*.cmd text eol=crlf\\n' > .gitattributes
printf '@echo off\\n' > command.cmd
chmod 644 readme.txt
chmod 755 run.sh
git add readme.txt run.sh .gitattributes command.cmd
chmod 755 readme.txt
chmod 644 run.sh
${normalization}
test ! -x readme.txt
test -x run.sh
test "$(wc -c < command.cmd | tr -d ' ')" = 11
git diff --quiet
printf edited > readme.txt
${normalization}
if git diff --quiet; then exit 9; fi
test "$(cat readme.txt)" = edited
printf protected
`);
  assert.equal(stdout, 'protected');
});

test('WSL copy-back keeps the canonical release artifact and its acceptance evidence together', async t => {
  const helper = (await readFile('scripts/linux-wsl.ps1', 'utf8')).replaceAll('\r\n', '\n');
  const start = helper.indexOf('mkdir -p "$SOURCE/release"');
  const copyBack = helper.slice(start, helper.indexOf("\n'@", start));
  assert.ok(start >= 0 && copyBack.includes('acceptance.json'));
  const { stdout } = await shell(t, `
SOURCE="$PWD/source with spaces"
version=0.2.1
artifact="Team-DevSpace-$version-linux-x64-offline.tar.gz"
mkdir -p "release/offline/$version/linux-x64" "$SOURCE/release/offline/$version/linux-x64"
printf new-artifact > "release/$artifact"
printf new-checksum > "release/$artifact.sha256"
printf '{"passed":true}' > "release/offline/$version/linux-x64/acceptance.json"
printf stale-artifact > "$SOURCE/release/offline/$version/linux-x64/$artifact"
${copyBack}
cmp "release/$artifact" "$SOURCE/release/$artifact"
cmp "release/$artifact" "$SOURCE/release/offline/$version/linux-x64/$artifact"
cmp "release/$artifact.sha256" "$SOURCE/release/offline/$version/linux-x64/$artifact.sha256"
cmp "release/offline/$version/linux-x64/acceptance.json" "$SOURCE/release/offline/$version/linux-x64/acceptance.json"
printf synchronized
`);
  assert.ok(stdout.endsWith('synchronized'));
});

test('macOS damaged-client uninstall waits for launchd and retains startup files on timeout', async t => {
  const cleanup = script.slice(script.indexOf('remove_native_startup_fallback()'), script.indexOf('\nremove_distribution_payload()'))
    .replaceAll('/bin/launchctl', 'launchctl').replaceAll('/bin/sleep', 'sleep');
  for (const neverStops of [false, true]) {
    const { stdout } = await shell(t, `
TARGET=darwin-arm64
HOME="$PWD/home"
TEAM_DEVSPACE_HOME="$HOME/Library/Application Support/TeamDevSpace"
runtime_plist="$HOME/Library/LaunchAgents/com.teamdevspace.runtime.plist"
mkdir -p "$(dirname "$runtime_plist")"
printf '%s' "$TEAM_DEVSPACE_HOME" > "$runtime_plist"
printf 0 > probes
launchctl() {
  [ "$1" != bootout ] || return 0
  count=$(cat probes)
  count=$((count + 1))
  printf '%s' "$count" > probes
  ${neverStops ? 'return 0' : '[ "$count" -lt 3 ]'}
}
sleep() { :; }
${cleanup}
${neverStops ? 'if remove_native_startup_fallback; then exit 9; fi; test -f "$runtime_plist"; test "$(cat probes)" -ge 100; test "$(cat probes)" -le 102' : 'remove_native_startup_fallback; test ! -f "$runtime_plist"; test "$(cat probes)" -eq 3'}
printf protected
`);
    assert.equal(stdout, 'protected');
  }
});

test('Unix damaged-client uninstall has a native startup fallback', () => {
  assert.match(script, /remove_native_startup_fallback/);
  assert.match(script, /invoke_client "\$current" uninstall/);
  assert.match(script, /Installed client uninstall failed; using native startup cleanup fallback/);
  assert.match(script, /team-devspace-runtime\.service/);
  assert.ok(script.includes('label="com.teamdevspace.$component"'));
});
