import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const RUNTIME_PROFILE = 'no-subagents-target-native-v2';

// Team DevSpace disables local subagents. Do not prune the SDK itself or arbitrary
// production dependencies: only optional platform executables and foreign PTYs.
export async function pruneRuntime(bundle, target) {
  if (target === 'win32-x64') return [];
  if (!/^(darwin|linux)-(arm64|x64)$/.test(target)) throw new Error(`Unsupported runtime target: ${target}`);
  const lock = JSON.parse(await readFile(join(bundle, 'package-lock.json'), 'utf8'));
  const removed = [];
  const scope = join(bundle, 'node_modules', '@anthropic-ai');
  for (const entry of await readdir(scope, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('claude-agent-sdk-')) continue;
    const relative = `node_modules/@anthropic-ai/${entry.name}`;
    if (lock.packages?.[relative]?.optional !== true) {
      throw new Error(`Refusing to prune a non-optional dependency: ${relative}`);
    }
    await rm(join(bundle, relative), { recursive: true, force: true });
    removed.push(relative);
  }
  const prebuilds = join(bundle, 'node_modules', 'node-pty', 'prebuilds');
  const entries = await readdir(prebuilds, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory() && /^(win32|darwin|linux)-(x64|arm64)$/.test(entry.name) && entry.name !== target) {
      await rm(join(prebuilds, entry.name), { recursive: true, force: true });
      removed.push(`node_modules/node-pty/prebuilds/${entry.name}`);
    }
  }
  return removed;
}
