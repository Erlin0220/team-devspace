import { lstat, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { readJson, RELEASE_VERSION } from './state.mjs';
import { UPDATE_VERSION } from './update-policy.mjs';
import { DOWNLOAD_TARGETS, packageName } from './release-catalog.mjs';

// This owns only canonical downloaded packages, not installed payloads or user
// files. Share the apply lock so a download/installer handoff cannot race GC.
export async function pruneUpdateCache(home, policy, now = Date.now()) {
  const directory = join(home, 'updates');
  let unlock;
  try { unlock = await lockfile.lock(join(directory, '.apply'), { realpath: false, lockfilePath: join(directory, '.apply.lock'), stale: 30000, update: 5000 }); }
  catch (error) { if (error.code === 'ELOCKED' || error.code === 'ENOENT') return; throw error; }
  try {
    const attempt = await readJson(join(directory, 'attempt.json'), null);
    const request = await readJson(join(directory, 'install-request.json'), null);
    const keep = new Set([RELEASE_VERSION, policy?.stable, policy?.auto, attempt?.version, request?.version]);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UPDATE_VERSION.test(entry.name)) continue;
      const versionDirectory = join(directory, entry.name);
      const names = DOWNLOAD_TARGETS.map(target => packageName(entry.name, target));
      for (const file of await readdir(versionDirectory, { withFileTypes: true })) {
        if (!file.isFile() || file.isSymbolicLink()) continue;
        const canonical = names.includes(file.name);
        const partial = names.some(name => file.name.startsWith(`${name}.`) &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.part$/.test(file.name.slice(name.length + 1)));
        if ((!canonical && !partial) || (canonical && keep.has(entry.name))) continue;
        const path = join(versionDirectory, file.name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        if (partial && now - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
        await rm(path, { force: true });
      }
      // An unknown file, subdirectory or symlink is never recursively removed.
      if (!keep.has(entry.name)) await rmdir(versionDirectory).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; });
    }
  } finally { await unlock(); }
}
