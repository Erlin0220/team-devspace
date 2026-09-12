import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function sourceIdentity(cwd = process.cwd()) {
  const options = { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 };
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
  // Compare canonical Git content and modes, not rsync/DrvFS stat-cache hints.
  // Include staged changes and untracked source; errors never count as clean.
  const diff = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], options);
  if (diff.error || ![0, 1].includes(diff.status)) throw diff.error ?? new Error('Cannot verify source changes');
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], options);
  return { commit, sourceDirty: diff.status === 1 || untracked.length > 0 };
}

export async function downloadPinned(artifact, cache) {
  if (new URL(artifact.url).protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error('Every binary must have an HTTPS origin and an exact SHA-256 pin');
  }
  await mkdir(cache, { recursive: true });
  const target = join(cache, basename(new URL(artifact.url).pathname));
  try {
    await access(target);
    if (await sha256File(target) === artifact.sha256) return target;
    await rm(target); // An interrupted/invalid build cache is replaceable; never execute it.
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target}.${process.pid}.partial`;
  try {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    await run(curl, ['--fail', '--location', '--proto', '=https', '--tlsv1.2',
      '--retry', '4', '--retry-all-errors', '--retry-delay', '2', '--connect-timeout', '30', '--max-time', '240',
      '--output', temporary, artifact.url], { timeout: 270000 });
    const size = (await stat(temporary)).size;
    if (size <= 0 || size > 256 * 1024 * 1024) throw new Error('Binary download exceeds release size limit');
    if (await sha256File(temporary) !== artifact.sha256) throw new Error(`Downloaded binary failed SHA-256 verification: ${basename(target)}`);
    await rename(temporary, target);
    return target;
  } finally { await rm(temporary, { force: true }); }
}

export function run(command, args, { cwd, env, capture = false, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
    let stdout = ''; let stderr = '';
    if (capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${basename(command)} exceeded its build timeout`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${basename(command)} exited ${code}${capture ? `\n${stderr.slice(-6000)}\n${stdout.slice(-3000)}` : ''}`));
      else resolve({ stdout, stderr });
    });
  });
}
