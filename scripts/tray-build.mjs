import { access, chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { delimiter, dirname, join, resolve } from 'node:path';
import { downloadPinned, run, sha256File } from './build-utils.mjs';
import { peDetails, WINDOWS_GUI_SUBSYSTEM, WINDOWS_X64_MACHINE, zigCompiler } from './windows-launcher.mjs';
import release from '../release.config.json' with { type: 'json' };

const RUSTUP = {
  url: 'https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-pc-windows-msvc/rustup-init.exe',
  sha256: '88d8258dcf6ae4f7a80c7d1088e1f36fa7025a1cfd1343731b4ee6f385121fc0',
};

async function commandExists(command) {
  try { await run(command, ['--version'], { capture: true, timeout: 30000 }); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const MACOS_TRAY_CACHE_SCHEMA = 1;

export async function readTrayArtifactCache({ binary, metadataPath, fingerprint,
  target = 'darwin-arm64', minimumMacOS = release.distribution.macosMinimumVersion }) {
  const manifest = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (manifest.schema !== MACOS_TRAY_CACHE_SCHEMA || manifest.fingerprint !== fingerprint ||
      manifest.target !== target || manifest.minimumMacOS !== minimumMacOS ||
      typeof manifest.rustVersion !== 'string' || !manifest.rustVersion.startsWith('rustc ') ||
      !Array.isArray(manifest.metadata?.packages) || !Array.isArray(manifest.metadata?.resolve?.nodes) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')) {
    throw new Error('Cached macOS tray metadata differs from the current build contract');
  }
  await access(binary, 1);
  if (await sha256File(binary) !== manifest.sha256) {
    throw new Error('Cached macOS tray binary hash differs from its metadata');
  }
  return { metadata: manifest.metadata, rustVersion: manifest.rustVersion, sha256: manifest.sha256, cached: true };
}

async function cachedMacTray(destination) {
  if (process.platform !== 'darwin') return null;
  const binary = process.env.TEAM_DEVSPACE_TRAY_BINARY;
  const metadataPath = process.env.TEAM_DEVSPACE_TRAY_METADATA;
  if (!binary && !metadataPath) return null;
  if (!binary || !metadataPath || !process.env.TEAM_DEVSPACE_TRAY_FINGERPRINT) {
    throw new Error('Prepared macOS tray cache is incomplete');
  }
  const result = await readTrayArtifactCache({ binary, metadataPath,
    fingerprint: process.env.TEAM_DEVSPACE_TRAY_FINGERPRINT });
  await mkdir(dirname(destination), { recursive: true });
  await cp(binary, destination);
  await chmod(destination, 0o755);
  return result;
}

async function storeMacTrayCache(binary, result) {
  if (process.platform !== 'darwin') return;
  const cacheDirectory = process.env.TEAM_DEVSPACE_TRAY_CACHE_DIR;
  const fingerprint = process.env.TEAM_DEVSPACE_TRAY_FINGERPRINT;
  if (!cacheDirectory || !fingerprint) return;
  const sha256 = await sha256File(binary);
  const staging = `${cacheDirectory}.tmp-${process.pid}-${randomUUID()}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const cachedBinary = join(staging, 'TeamDevSpaceTray');
    await cp(binary, cachedBinary);
    await chmod(cachedBinary, 0o755);
    await writeFile(join(staging, 'TeamDevSpaceTray.sha256'), `${sha256}  TeamDevSpaceTray\n`);
    await writeFile(join(staging, 'metadata.json'), `${JSON.stringify({
      schema: MACOS_TRAY_CACHE_SCHEMA,
      fingerprint,
      target: 'darwin-arm64',
      minimumMacOS: release.distribution.macosMinimumVersion,
      sha256,
      rustVersion: result.rustVersion,
      metadata: result.metadata,
    }, null, 2)}\n`);
    await mkdir(dirname(cacheDirectory), { recursive: true });
    await rm(cacheDirectory, { recursive: true, force: true });
    await rename(staging, cacheDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function cargoCommand() {
  if (process.env.CARGO) return { cargo: process.env.CARGO, env: {} };
  if (await commandExists('cargo')) return { cargo: 'cargo', env: {} };
  if (process.platform !== 'win32') throw new Error('The exact Rust toolchain from native/tray/rust-toolchain.toml is required');
  const root = resolve('build/rust-toolchain');
  const cargoHome = join(root, 'cargo');
  const rustupHome = join(root, 'rustup');
  const cargo = join(cargoHome, 'bin', 'cargo.exe');
  const env = { CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome,
    PATH: `${join(cargoHome, 'bin')}${delimiter}${process.env.PATH ?? ''}` };
  let ready = false;
  try { await access(cargo); await run(cargo, ['--version'], { env, capture: true, timeout: 30000 }); ready = true; }
  catch {}
  if (!ready) {
    const rustup = await downloadPinned(RUSTUP, resolve('build/downloads'));
    await mkdir(root, { recursive: true });
    await run(rustup, ['-y', '--no-modify-path', '--profile', 'minimal', '--default-host',
      'x86_64-pc-windows-gnu', '--default-toolchain', '1.85.1'], { env, timeout: 600000 });
  }
  const selfContained = join(rustupHome, 'toolchains', '1.85.1-x86_64-pc-windows-gnu',
    'lib', 'rustlib', 'x86_64-pc-windows-gnu', 'bin', 'self-contained');
  env.PATH = `${selfContained}${delimiter}${env.PATH}`;
  env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = join(selfContained, 'x86_64-w64-mingw32-gcc.exe');
  return { cargo, env };
}

export async function buildTray(destination) {
  if (!['win32', 'darwin'].includes(process.platform)) return null;
  const cached = await cachedMacTray(destination);
  if (cached) return cached;
  const { cargo, env } = await cargoCommand();
  const targetDirectory = resolve(`build/tray-target-${process.platform}-${process.arch}`);
  const buildEnv = { ...env, CARGO_TARGET_DIR: targetDirectory,
    ...(process.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: release.distribution.macosMinimumVersion } : {}) };
  const gnuLinker = buildEnv.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER ??
    process.env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER;
  if (process.platform === 'win32' && gnuLinker) {
    const zig = await zigCompiler();
    const assembler = join(gnuLinker, '..', 'as.exe');
    await run(zig, ['cc', resolve('native/tray/zig-as.c'), '-target', 'x86_64-windows-gnu',
      '-municode', '-Os', '-s', '-o', assembler], { capture: true, timeout: 120000 });
    buildEnv.TDS_ZIG = zig;
  }
  const crate = resolve('native/tray');
  if (process.env.TEAM_DEVSPACE_SKIP_TRAY_TESTS !== '1') {
    await run(cargo, ['test', '--release', '--locked'], { cwd: crate, env: buildEnv, timeout: 900000 });
  }
  await run(cargo, ['build', '--release', '--locked'], { cwd: crate, env: buildEnv, timeout: 900000 });
  const binary = join(targetDirectory, 'release', process.platform === 'win32'
    ? 'team-devspace-tray.exe' : 'team-devspace-tray');
  await access(binary);
  if (process.platform === 'win32') {
    const pe = await peDetails(binary);
    if (pe.subsystem !== WINDOWS_GUI_SUBSYSTEM || pe.machine !== WINDOWS_X64_MACHINE || pe.clrHeaderSize !== 0) {
      throw new Error('Windows tray must be a native x64 GUI executable with no Console subsystem');
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(binary, destination);
  const filterPlatform = process.platform === 'win32'
    ? (gnuLinker ? 'x86_64-pc-windows-gnu' : 'x86_64-pc-windows-msvc')
    : process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const metadata = await run(cargo, ['metadata', '--locked', '--format-version', '1', '--filter-platform', filterPlatform],
    { cwd: crate, env: buildEnv, capture: true, timeout: 120000 });
  const rustcCommand = /[\\/]/.test(cargo)
    ? join(dirname(resolve(cargo)), process.platform === 'win32' ? 'rustc.exe' : 'rustc') : 'rustc';
  const rustc = await run(rustcCommand,
    ['--version'], { env: buildEnv, capture: true, timeout: 30000 });
  const result = { metadata: JSON.parse(metadata.stdout), rustVersion: rustc.stdout.trim(),
    sha256: await sha256File(binary), cached: false };
  await storeMacTrayCache(binary, result);
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  const output = resolve(process.argv[2] ?? `build/team-devspace-tray${process.platform === 'win32' ? '.exe' : ''}`);
  const result = await buildTray(output);
  console.log(JSON.stringify({ built: output, rustVersion: result?.rustVersion,
    packages: result?.metadata.resolve.nodes.length }));
}
