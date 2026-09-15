import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macUiCompileArgs } from '../scripts/macos-ui-build.mjs';
import release from '../release.config.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import { desktopState } from '../client/desktop-controller.mjs';

test('native package smoke imports the production projection before npm dependencies exist', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tds-tray-no-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'client'));
  for (const file of ['client/desktop-state.mjs', 'package.json', 'release.config.json']) await cp(file, join(root, file));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {desktopState} from './client/desktop-state.mjs'; console.log(desktopState(null).menu.some(item => item.action === 'settings'));"],
    { cwd: root, encoding: 'utf8' });
  assert.equal(output.trim(), 'true');
});

test('AppKit build uses the pinned deployment floor and native target architecture', () => {
  for (const [architecture, triple] of [
    ['arm64', `arm64-apple-macosx${release.distribution.macosMinimumVersion}`],
    ['x64', `x86_64-apple-macosx${release.distribution.macosMinimumVersion}`],
  ]) {
    const args = macUiCompileArgs('build/test-ui', release.distribution.macosMinimumVersion, architecture);
    assert.equal(args[0], '--sdk');
    assert.equal(args[1], 'macosx');
    assert.equal(args[2], 'swiftc');
    assert.equal(args.includes('-parse-as-library'), true, 'The single Swift file uses an explicit @main entrypoint');
    assert.equal(args[args.indexOf('-target') + 1], triple);
    assert.equal(args[args.indexOf('-framework') + 1], 'AppKit');
    assert.equal(args.includes('-static-stdlib'), false);
  }
  assert.throws(() => macUiCompileArgs('build/test-ui', 'latest', 'arm64'), /explicit/);
  assert.throws(() => macUiCompileArgs('build/test-ui', release.distribution.macosMinimumVersion, 'ia32'), /Unsupported/);
});

test('desktop About metadata has one author source and one shared Control Center', async () => {
  assert.deepEqual(packageJson.author, { name: 'Erlin0220', email: '24458678+Erlin0220@users.noreply.github.com' });
  const state = desktopState(null);
  assert.deepEqual(state.author, packageJson.author);
  assert.equal(state.version, release.version);
  assert.equal(state.devspaceVersion, release.devspaceVersion);
  const [html, ui, packaging, rust, swift] = await Promise.all([
    readFile('client/control.html', 'utf8'), readFile('client/control.js', 'utf8'), readFile('scripts/package.mjs', 'utf8'),
    readFile('native/tray/src/main.rs', 'utf8'), readFile('native/macos/TeamDevSpaceUI.swift', 'utf8'),
  ]);
  assert.match(html, /id="author"/);
  assert.match(ui, /state\.author\.name/);
  assert.match(ui, /state\.author\.email/);
  assert.doesNotMatch(html, /@users\.noreply\.github\.com/);
  assert.doesNotMatch(rust, /show_about|show_message_box/);
  assert.doesNotMatch(swift, /showAbout|orderFrontStandardAboutPanel/);
  assert.match(packaging, /TeamDevSpaceAuthorName/);
  assert.match(packaging, /TeamDevSpaceAuthorEmail/);
});

test('macOS UI has one AppKit implementation and Windows retains its Rust build', async () => {
  const [builder, workflow, rust, swift, setup] = await Promise.all([
    readFile('scripts/tray-build.mjs', 'utf8'), readFile('codemagic.yaml', 'utf8'),
    readFile('native/tray/src/main.rs', 'utf8'), readFile('native/macos/TeamDevSpaceUI.swift', 'utf8'),
    readFile('client/setup.mjs', 'utf8'),
  ]);
  assert.match(builder, /process\.platform === 'darwin'\) return buildMacUi/);
  assert.match(builder, /'build', '--release', '--locked'/);
  assert.match(workflow, /architecture:/);
  assert.match(workflow, /- arm64/);
  assert.match(workflow, /- x64/);
  assert.match(workflow, /\/usr\/bin\/arch -x86_64/);
  assert.doesNotMatch(workflow, /TEAM_DEVSPACE_TRAY_|tray_fingerprint|rustup/);
  assert.doesNotMatch(rust, /target_os = "macos"/);
  assert.match(swift, /NSStatusBar\.system\.statusItem/);
  assert.match(swift, /TeamDevSpaceTemplate/);
  assert.match(swift, /image\.isTemplate = true/);
  assert.doesNotMatch(swift, /systemSymbolName:\s*symbol/);
  assert.match(swift, /@MainActor/);
  assert.match(swift, /NSSecureTextField/);
  assert.match(swift, /NSOpenPanel/);
  assert.match(swift, /flock\(descriptor, LOCK_EX \| LOCK_NB\)/);
  assert.doesNotMatch(swift, /add\(menu, "check"/);
  assert.doesNotMatch(swift, /URLSession|launchctl|state\.json|UserDefaults/);
  assert.doesNotMatch(setup, /osascript|display dialog|choose folder/);
});
