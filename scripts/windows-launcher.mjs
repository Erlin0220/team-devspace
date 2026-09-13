import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { downloadPinned, run, sha256File } from './build-utils.mjs';

export const WINDOWS_GUI_SUBSYSTEM = 2;
export const WINDOWS_X64_MACHINE = 0x8664;

export async function peDetails(path) {
  const image = await readFile(path);
  if (image.length < 256 || image[0] !== 0x4d || image[1] !== 0x5a) throw new Error('Windows launcher is not a PE image');
  const pe = image.readUInt32LE(0x3c);
  if (pe + 256 >= image.length || image.toString('ascii', pe, pe + 4) !== 'PE\0\0') {
    throw new Error('Windows launcher has an invalid PE header');
  }
  const optional = pe + 24;
  const magic = image.readUInt16LE(optional);
  const dataDirectories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0);
  if (!dataDirectories) throw new Error('Windows launcher has an unknown PE optional header');
  return {
    machine: image.readUInt16LE(pe + 4),
    subsystem: image.readUInt16LE(optional + 68),
    clrHeaderSize: image.readUInt32LE(dataDirectories + (14 * 8) + 4),
  };
}

export async function peSubsystem(path) { return (await peDetails(path)).subsystem; }

export async function zigCompiler() {
  const target = 'win32-x64';
  const binaries = JSON.parse(await readFile(new URL('./binaries.json', import.meta.url), 'utf8'));
  const artifact = binaries.zig[target];
  const root = resolve('build/zig-win32-x64');
  let compiler;
  try {
    const directory = (await readdir(root, { withFileTypes: true })).find(entry => entry.isDirectory());
    compiler = directory && join(root, directory.name, 'zig.exe');
    await access(compiler);
    if (await sha256File(compiler) !== artifact.executableSha256) throw new Error('Cached Zig executable hash differs from build contract');
    const cachedVersion = (await run(compiler, ['version'], { capture: true, timeout: 30000 })).stdout.trim();
    if (cachedVersion === '0.15.2') return compiler;
  } catch {}

  const cache = resolve('build/cache');
  const archive = await downloadPinned(artifact, cache);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await run(tar, ['-xf', archive, '-C', root], { timeout: 120000 });
  const directory = (await readdir(root, { withFileTypes: true })).find(entry => entry.isDirectory());
  if (!directory) throw new Error('Unexpected Zig archive layout');
  compiler = join(root, directory.name, 'zig.exe');
  if (await sha256File(compiler) !== artifact.executableSha256) throw new Error('Pinned Zig executable hash differs from build contract');
  const version = (await run(compiler, ['version'], { capture: true, timeout: 30000 })).stdout.trim();
  if (version !== '0.15.2') throw new Error('Pinned Zig compiler version differs from build contract');
  return compiler;
}

export async function buildWindowsLauncher(output, source = resolve('platform/windows/tds-launcher.c')) {
  if (process.platform !== 'win32') throw new Error('Build the Windows launcher on Windows x64');
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  // Windows Shell accepts a PNG-backed ICO; reuse the product icon without an
  // image library, generated artwork or another desktop runtime dependency.
  const png = await readFile(resolve('native/tray/assets/team-devspace.png'));
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width > 256 || height > 256) throw new Error('Shortcut PNG must fit a Windows icon');
  const icon = Buffer.alloc(22);
  icon.writeUInt16LE(1, 2); icon.writeUInt16LE(1, 4);
  icon[6] = width % 256; icon[7] = height % 256;
  icon.writeUInt16LE(1, 10); icon.writeUInt16LE(32, 12);
  icon.writeUInt32LE(png.length, 14); icon.writeUInt32LE(22, 18);
  await writeFile(join(dirname(output), 'team-devspace.ico'), Buffer.concat([icon, png]));
  const zig = await zigCompiler();
  await run(zig, ['cc', source, '-target', 'x86_64-windows-gnu', '-municode',
    '-Wl,--subsystem,windows', '-Os', '-s', '-o', output, '-lshell32'], { capture: true, timeout: 120000 });
  const pe = await peDetails(output);
  if (pe.subsystem !== WINDOWS_GUI_SUBSYSTEM || pe.machine !== WINDOWS_X64_MACHINE || pe.clrHeaderSize !== 0) {
    throw new Error('Windows launcher must be a native x64 GUI executable');
  }
  return output;
}
