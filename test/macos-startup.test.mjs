import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const launch = await readFile('platform/macos/launch-app.sh', 'utf8');
const bootstrap = await readFile('platform/unix/bootstrap.sh', 'utf8');
const preinstall = await readFile('platform/macos/preinstall', 'utf8');
const lockCode = launch.slice(launch.indexOf('acquire_launch_lock()'), launch.indexOf('trap cleanup_launch EXIT'));
const rollbackStart = bootstrap.indexOf('rollback_candidate()');
const rollbackCode = bootstrap.slice(rollbackStart, bootstrap.indexOf('\nif [ "$MODE" = uninstall ]', rollbackStart));

async function shell(t, code) {
  const cwd = await mkdtemp(join(tmpdir(), 'tds-macos-startup-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return exec('bash', ['-c', `set -eu\n${code}`], { cwd, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' } });
}

test('macOS package and payload guards allow Intel on Apple Silicon only with working Rosetta', async t => {
  const preflight = preinstall.slice(preinstall.indexOf('if [ "$ARCH" = x86_64 ]'), preinstall.indexOf('\nMACOS_VERSION='));
  const payload = bootstrap.slice(bootstrap.indexOf('[ "$schema" = 1 ]'), bootstrap.indexOf('\ncase "$release" in'));
  for (const [machine, target, rosetta, accepted] of [
    ['arm64', 'x64', 0, true], ['arm64', 'x64', 1, false],
    ['x64', 'arm64', 0, false], ['arm64', 'arm64', 1, true], ['x64', 'x64', 1, true],
  ]) {
    for (const [kind, guard] of [['package', preflight], ['payload', payload]]) {
      const run = shell(t, `
ARCH=${machine}
EXPECTED_ARCH=${target}
TARGET=darwin-${machine}
manifest_target=darwin-${target}
MACHINE_ARCH=${machine}
KERNEL_ARCH=${machine}
SYSTEM_NAME=Darwin
LOG=/dev/null
schema=1
trust=bootstrap-embedded-manifest
log() { :; }
rosetta_available() { return ${rosetta}; }
${guard.replaceAll('/usr/bin/arch -x86_64 /usr/bin/true', 'rosetta_available')}
printf accepted
`);
      if (accepted) assert.equal((await run).stdout, 'accepted', `${kind}: ${machine} -> ${target}`);
      else await assert.rejects(run, { code: kind === 'package' ? 1 : 2 });
    }
  }
});

test('macOS launch lock never steals a live owner or a not-yet-published PID', async t => {
  for (const metadata of ['printf "%s\\n" "$$" > "$LAUNCH_LOCK/pid"', ':']) {
    const { stdout } = await shell(t, `
LAUNCH_LOCK="$PWD/app-launch.lock"
mkdir "$LAUNCH_LOCK"
${metadata}
${lockCode}
printf 'incorrectly-acquired'
`);
    assert.equal(stdout, '');
  }
});

test('macOS launch lock recovers a dead owner and releases only its own lock', async t => {
  const { stdout } = await shell(t, `
LAUNCH_LOCK="$PWD/app-launch.lock"
mkdir "$LAUNCH_LOCK"
printf '2147483646\\n' > "$LAUNCH_LOCK/pid"
${lockCode}
test "$(cat "$LAUNCH_LOCK/pid")" = "$$"
cleanup_launch
test ! -e "$LAUNCH_LOCK"
printf 'recovered'
`);
  assert.equal(stdout, 'recovered');
  const changed = await shell(t, `
LAUNCH_LOCK="$PWD/app-launch.lock"
${lockCode}
printf 'different-owner\\n' > "$LAUNCH_LOCK/pid"
cleanup_launch
test -f "$LAUNCH_LOCK/pid"
printf 'retained'
`);
  assert.equal(changed.stdout, 'retained');
});

test('macOS first-run rollback without device state reuses native cleanup, not CLI uninstall', async t => {
  const { stderr } = await shell(t, `
STATE_HOME="$PWD/state"
candidate="$PWD/candidate"
current=''
mkdir -p "$STATE_HOME" "$candidate"
invoke_client() { echo 'unexpected CLI state lookup' >&2; return 1; }
remove_native_startup_fallback() { printf 'fallback-cleanup\\n'; }
remove_linux_cli() { :; }
${rollbackCode}
rollback_candidate 'New version failed setup'
test ! -e "$candidate"
`);
  assert.match(stderr, /partial candidate startup state was removed/);
  assert.doesNotMatch(stderr, /unexpected CLI|cleanup also failed|ENOENT/);
});

test('macOS failed cleanup retains the candidate instead of deleting possibly running binaries', async t => {
  const { stderr } = await shell(t, `
STATE_HOME="$PWD/state"
candidate="$PWD/candidate"
current=''
mkdir -p "$STATE_HOME" "$candidate"
remove_native_startup_fallback() { return 1; }
remove_linux_cli() { :; }
${rollbackCode}
rollback_candidate 'New version failed setup'
test -d "$candidate"
`);
  assert.match(stderr, /candidate startup cleanup also failed/);
});

test('reopening an installed but unconfigured macOS payload shows setup without reinstalling', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tds-macos-reopen-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const contents = join(cwd, 'Team DevSpace.app', 'Contents');
  const resources = join(contents, 'Resources');
  const macos = join(contents, 'MacOS');
  const home = join(cwd, 'home');
  const distribution = join(home, 'Library', 'Application Support', 'TeamDevSpace', 'distribution');
  const current = join(distribution, 'versions', 'unconfigured');
  for (const path of [resources, macos, join(current, 'runtime', 'bin'), join(current, 'client')]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(macos, 'TeamDevSpace'), launch, { mode: 0o755 });
  await writeFile(join(resources, 'release-manifest.json'), '{}');
  await writeFile(join(current, 'install-manifest.json'), '{}');
  await writeFile(join(current, 'client', 'cli.mjs'), '');
  await writeFile(join(current, 'runtime', 'bin', 'node'), '#!/bin/sh\n[ "$2" = setup-gui ] || exit 8\nprintf "setup-reopened\\n"\n', { mode: 0o755 });
  // Use the shell's own path representation so Git Bash and POSIX hosts both run this test.
  await exec('bash', ['-c', `set -eu
export HOME="$PWD/home"
D="$HOME/Library/Application Support/TeamDevSpace/distribution"
printf '%s\\n' "$D/versions/unconfigured" > "$D/active-path"
/bin/sh "$PWD/Team DevSpace.app/Contents/MacOS/TeamDevSpace"
test ! -e "$HOME/Library/Application Support/TeamDevSpace/app-launch.lock"
`], { cwd, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' } });
  const log = await readFile(join(home, 'Library', 'Application Support', 'TeamDevSpace', 'logs', 'setup.log'), 'utf8');
  assert.match(log, /setup-reopened/);
  assert.doesNotMatch(log, /falling back to bootstrap/);
});

test('reopening a configured macOS payload reuses healthy startup even when its log directory is unavailable', async t => {
  const work = await mkdtemp(join(tmpdir(), 'tds-macos-reuse-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  for (const blocked of [false, true]) {
    const cwd = join(work, String(blocked)), home = join(cwd, 'home');
    const contents = join(cwd, 'Team DevSpace.app', 'Contents');
    const resources = join(contents, 'Resources'), macos = join(contents, 'MacOS');
    const stateHome = join(home, 'Library', 'Application Support', 'TeamDevSpace');
    const current = join(stateHome, 'distribution', 'versions', 'configured');
    for (const path of [resources, macos, join(current, 'runtime', 'bin'), join(current, 'client')]) await mkdir(path, { recursive: true });
    await writeFile(join(macos, 'TeamDevSpace'), launch, { mode: 0o755 });
    await writeFile(join(resources, 'release-manifest.json'), '{}');
    await writeFile(join(current, 'install-manifest.json'), '{}');
    await writeFile(join(current, 'client', 'cli.mjs'), '');
    await writeFile(join(stateHome, 'state.json'), '{}');
    if (blocked) await writeFile(join(stateHome, 'logs'), 'not a directory');
    await writeFile(join(current, 'runtime', 'bin', 'node'), '#!/bin/sh\n[ "$2" = start ] || exit 8\nprintf "start-once\\n" >> "$HOME/proof"\n', { mode: 0o755 });
    const script = [
      'set -eu', 'export HOME="$PWD/home"',
      'D="$HOME/Library/Application Support/TeamDevSpace/distribution"',
      'printf "%s\\n" "$D/versions/configured" > "$D/active-path"',
      '/bin/sh "$PWD/Team DevSpace.app/Contents/MacOS/TeamDevSpace"',
    ].join('\n');
    await exec('bash', ['-c', script], { cwd, timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(await readFile(join(home, 'proof'), 'utf8'), 'start-once\n');
  }
});
