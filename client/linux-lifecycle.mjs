import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Absence is a capability, not a vendor name. A broken/misconfigured user
// manager must not silently create a second owner beside existing systemd jobs.
export async function linuxServiceManager({ run = exec, exists = path => access(path).then(() => true, () => false) } = {}) {
  try {
    await run('systemctl', ['--user', 'show-environment'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return 'systemd-user';
  } catch (error) {
    if (error.code === 'ENOENT' && !await exists('/usr/bin/systemctl') && !await exists('/bin/systemctl')) return 'standalone';
    throw Object.assign(new Error('The systemd user manager is unavailable. Repair the user session/PATH; standalone was not started beside a possibly running systemd service.'),
      { code: 'linux_user_manager_unavailable', cause: error });
  }
}
