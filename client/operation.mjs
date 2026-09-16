import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { privateDirectory } from './state.mjs';

const operation = new AsyncLocalStorage();

// One mutation owner per installation, shared by the CLI, tray and installers.
// Native SQLite file ownership is released by the OS on process exit/crash, so
// lifecycle serialization does not need a heartbeat or stale-file lease.
export async function withDeviceOperation(home, task) {
  await privateDirectory(home);
  const canonical = await realpath(home);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  if (operation.getStore() === key) return task();
  let release;
  try {
    release = await acquireProcessLock(join(key, '.lifecycle-lock.sqlite'), {
      retries: 20, minTimeout: 100, maxTimeout: 250, factor: 1.2,
    });
  } catch (error) {
    if (error.code === 'process_lock_busy') throw Object.assign(
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
