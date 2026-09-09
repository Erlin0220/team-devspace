import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
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
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(240000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${basename(target)}`);
    if (new URL(response.url).protocol !== 'https:') throw new Error('Insecure binary download redirect');
    let size = 0;
    const maximum = 256 * 1024 * 1024;
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > maximum ? new Error('Binary download exceeds release size limit') : null, chunk);
      },
    }), createWriteStream(temporary, { flags: 'wx' }));
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
