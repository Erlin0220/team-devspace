import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { run, sha256File } from './build-utils.mjs';
import release from './release-profile.mjs';

export function macUiCompileArgs(destination, minimum = release.distribution.macosMinimumVersion, architecture = process.arch) {
  if (!/^\d+\.\d+$/.test(minimum)) throw new Error('An explicit macOS deployment target is required');
  const triple = architecture === 'arm64' ? `arm64-apple-macosx${minimum}`
    : architecture === 'x64' ? `x86_64-apple-macosx${minimum}` : null;
  if (!triple) throw new Error(`Unsupported macOS architecture: ${architecture}`);
  return ['--sdk', 'macosx', 'swiftc', '-parse-as-library', '-swift-version', '5', '-O', '-target', triple,
    '-framework', 'AppKit', resolve('native/macos/TeamDevSpaceUI.swift'), '-o', resolve(destination)];
}

export async function buildMacUi(destination) {
  if (process.platform !== 'darwin') throw new Error('AppKit must be compiled with the macOS Apple SDK');
  await mkdir(dirname(destination), { recursive: true });
  await run('/usr/bin/xcrun', macUiCompileArgs(destination), { timeout: 300000 });
  await chmod(destination, 0o755);
  // Runs without a GUI session, unlike native menu/form acceptance. A successful
  // compiler invocation alone must not be mistaken for employee desktop testing.
  await run(resolve(destination), ['--self-test'], { timeout: 10000 });
  const version = await run('/usr/bin/xcrun', ['swiftc', '--version'], { capture: true, timeout: 30000 });
  return { implementation: 'appkit', toolchain: version.stdout.trim(), sha256: await sha256File(destination) };
}
