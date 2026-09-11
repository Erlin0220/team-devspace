import { access, cp, mkdir, readFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { downloadPinned, run, sha256File } from './build-utils.mjs';
import { peDetails, WINDOWS_GUI_SUBSYSTEM, WINDOWS_X64_MACHINE, zigCompiler } from './windows-launcher.mjs';
import { buildMacUi } from './macos-ui-build.mjs';

const RUSTUP = {
  url: 'https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-pc-windows-msvc/rustup-init.exe',
  sha256: '88d8258dcf6ae4f7a80c7d1088e1f36fa7025a1cfd1343731b4ee6f385121fc0',
};

async function commandExists(command) {
  try { await run(command, ['--version'], { capture: true, timeout: 30000 }); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function cargoCommand() {
  if (process.env.CARGO) return { cargo: process.env.CARGO, env: {} };
  if (await commandExists('cargo')) return { cargo: 'cargo', env: {} };
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
  if (process.platform === 'darwin') return buildMacUi(destination);
  if (process.platform !== 'win32') return null;
  const { cargo, env } = await cargoCommand();
  const [release, packageJson] = await Promise.all([
    readFile('release.config.json', 'utf8').then(JSON.parse),
    readFile('package.json', 'utf8').then(JSON.parse),
  ]);
  const author = packageJson.author;
  if (!author?.name || !author?.email) throw new Error('package.json must define the Team DevSpace author name and email');
  const targetDirectory = resolve(`build/tray-target-${process.platform}-${process.arch}`);
  const buildEnv = { ...env, CARGO_TARGET_DIR: targetDirectory,
    TEAM_DEVSPACE_APP_VERSION: release.version,
    TEAM_DEVSPACE_DEVSPACE_VERSION: release.devspaceVersion,
    TEAM_DEVSPACE_AUTHOR_NAME: author.name,
    TEAM_DEVSPACE_AUTHOR_EMAIL: author.email };
  const gnuLinker = buildEnv.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER ??
    process.env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER;
  if (gnuLinker) {
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
  const binary = join(targetDirectory, 'release', 'team-devspace-tray.exe');
  await access(binary);
  const pe = await peDetails(binary);
  if (pe.subsystem !== WINDOWS_GUI_SUBSYSTEM || pe.machine !== WINDOWS_X64_MACHINE || pe.clrHeaderSize !== 0) {
    throw new Error('Windows tray must be a native x64 GUI executable with no Console subsystem');
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(binary, destination);
  const filterPlatform = gnuLinker ? 'x86_64-pc-windows-gnu' : 'x86_64-pc-windows-msvc';
  const metadata = await run(cargo, ['metadata', '--locked', '--format-version', '1', '--filter-platform', filterPlatform],
    { cwd: crate, env: buildEnv, capture: true, timeout: 120000 });
  const rustcCommand = /[\\/]/.test(cargo) ? join(dirname(resolve(cargo)), 'rustc.exe') : 'rustc';
  const rustc = await run(rustcCommand, ['--version'], { env: buildEnv, capture: true, timeout: 30000 });
  return { implementation: 'rust', metadata: JSON.parse(metadata.stdout), rustVersion: rustc.stdout.trim(),
    sha256: await sha256File(binary), cached: false };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  const output = resolve(process.argv[2] ?? `build/team-devspace-tray${process.platform === 'win32' ? '.exe' : ''}`);
  const result = await buildTray(output);
  console.log(JSON.stringify({ built: output, implementation: result?.implementation,
    toolchain: result?.toolchain ?? result?.rustVersion, packages: result?.metadata?.resolve.nodes.length }));
}
