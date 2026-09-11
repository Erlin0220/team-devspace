import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { macUiCompileArgs } from '../scripts/macos-ui-build.mjs';
import release from '../release.config.json' with { type: 'json' };

test('AppKit build uses the pinned deployment floor and only the system toolchain', () => {
  const args = macUiCompileArgs('build/test-ui');
  assert.equal(args[0], '--sdk');
  assert.equal(args[1], 'macosx');
  assert.equal(args[2], 'swiftc');
  assert.equal(args.includes('-parse-as-library'), true, 'The single Swift file uses an explicit @main entrypoint');
  assert.equal(args[args.indexOf('-target') + 1], `arm64-apple-macosx${release.distribution.macosMinimumVersion}`);
  assert.equal(args[args.indexOf('-framework') + 1], 'AppKit');
  assert.equal(args.includes('-static-stdlib'), false);
  assert.throws(() => macUiCompileArgs('build/test-ui', 'latest'), /explicit/);
});

test('macOS UI has one AppKit implementation and Windows retains its Rust build', async () => {
  const [builder, workflow, rust, swift, setup] = await Promise.all([
    readFile('scripts/tray-build.mjs', 'utf8'), readFile('codemagic.yaml', 'utf8'),
    readFile('native/tray/src/main.rs', 'utf8'), readFile('native/macos/TeamDevSpaceUI.swift', 'utf8'),
    readFile('client/setup.mjs', 'utf8'),
  ]);
  assert.match(builder, /process\.platform === 'darwin'\) return buildMacUi/);
  assert.match(builder, /'build', '--release', '--locked'/);
  assert.doesNotMatch(workflow, /TEAM_DEVSPACE_TRAY_|tray_fingerprint|rustup/);
  assert.doesNotMatch(rust, /target_os = "macos"/);
  assert.match(swift, /NSStatusBar\.system\.statusItem/);
  assert.match(swift, /image\?\.isTemplate = true/);
  assert.match(swift, /@MainActor/);
  assert.match(swift, /NSSecureTextField/);
  assert.match(swift, /NSOpenPanel/);
  assert.match(swift, /flock\(descriptor, LOCK_EX \| LOCK_NB\)/);
  assert.doesNotMatch(swift, /add\(menu, "check"/);
  assert.doesNotMatch(swift, /URLSession|launchctl|state\.json|UserDefaults/);
  assert.doesNotMatch(setup, /osascript|display dialog|choose folder/);
});
