import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { privateDirectory } from './state.mjs';

const operation = new AsyncLocalStorage();

// One mutation owner per installation, shared by the CLI, tray and installers.
// Reuse the existing dependency's atomic acquisition, heartbeat, crash recovery
// and compromise detection instead of implementing another lease mechanism.
export async function withDeviceOperation(home, task) {
  await privateDirectory(home);
  const canonical = await realpath(home);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  if (operation.getStore() === key) return task();
  let release;
  try {
    release = await lockfile.lock(key, {
      lockfilePath: join(key, '.lifecycle.lock'),
      stale: 30000,
      update: 5000,
      retries: { retries: 20, minTimeout: 100, maxTimeout: 250, factor: 1.2 },
    });
  } catch (error) {
    if (error.code === 'ELOCKED') throw Object.assign(
      new Error('另一个安装、修复或连接操作仍在进行；本次操作未执行，请完成后重试。'),
      { code: 'lifecycle_busy', cause: error });
    throw error;
  }
  try { return await operation.run(key, task); }
  finally { await release(); }
}

// Progress and presentation observers never own a lifecycle transaction. Handle
// both synchronous throws and async rejections without suppressing core errors.
export function notifyObserver(observer, ...args) {
  try { Promise.resolve(observer?.(...args)).catch(() => {}); } catch {}
}
