import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, stat, realpath, rm, link } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import release from '../release.config.json' with { type: 'json' };

const exec = promisify(execFile);
export const installRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEVSPACE_VERSION = release.devspaceVersion;
export const RELEASE_VERSION = release.version;

export function stateHome() {
  if (process.env.TEAM_DEVSPACE_HOME) return resolve(process.env.TEAM_DEVSPACE_HOME);
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'TeamDevSpace');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'TeamDevSpace');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'team-devspace');
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

export async function secureStateDirectory(home = stateHome()) {
  await privateDirectory(home);
  if (process.platform === 'win32') {
    const { stdout } = await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = /S-1-5-[0-9-]+/.exec(stdout)?.[0];
    if (!sid) throw new Error('Unable to resolve current Windows user SID');
    await exec(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
  }
}

export async function readJson(path, fallback) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) {
    if (error.code === 'ENOENT' && arguments.length > 1) return fallback;
    throw new Error(`Cannot read ${path}: ${error.code ?? 'invalid JSON'}`);
  }
}

async function atomicFile(path, content, { createOnly = false } = {}) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    if (createOnly) {
      try { await link(temporary, path); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    } else {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, path); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= 9) throw error;
          await sleep(10 * (attempt + 1));
        }
      }
    }
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return true;
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function atomicJson(path, value, options) {
  return atomicFile(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function atomicText(path, value, options) {
  return atomicFile(path, String(value), options);
}

export function randomSecret() { return randomBytes(32).toString('base64url'); }

export function normalizeGateway(value) {
  const url = new URL(value);
  // Plain HTTP is deliberately limited to local development, never arbitrary remote hosts.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Gateway must use HTTPS (only loopback may use HTTP)');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the gateway origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

function projectRootError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function projectRootFromState(state) {
  const value = state?.currentProjectRoot ?? (Array.isArray(state?.roots) ? state.roots[0] : undefined);
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\x00]/.test(value) || value === parse(value).root) return undefined;
  return value;
}

export async function approvedProjectRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\x00]/.test(value)) {
    throw projectRootError('project_root_invalid', '请选择完整的项目目录路径');
  }
  let root;
  try { root = await realpath(value); }
  catch { throw projectRootError('project_root_unavailable', '项目目录不存在或当前不可访问，请重新选择项目目录'); }
  if (!(await stat(root)).isDirectory()) throw projectRootError('project_root_invalid', '请选择一个项目目录');
  if (root === parse(root).root) throw projectRootError('project_root_invalid', '请选择具体项目目录，不要选择整个磁盘');
  return root;
}

export async function projectRootAvailable(value) {
  if (!projectRootFromState({ currentProjectRoot: value })) return false;
  try { return (await stat(value)).isDirectory(); }
  catch { return false; }
}

export async function loadState(home = stateHome()) {
  const state = await readJson(join(home, 'state.json'));
  const currentProjectRoot = projectRootFromState(state);
  if (state.schema !== 1 || typeof state.deviceId !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(state.deviceSecret ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(state.ownerToken ?? '') ||
      !currentProjectRoot ||
      !['devspace', 'bridge', 'metrics'].every(key => Number.isInteger(state.ports?.[key]) && state.ports[key] >= 1024 && state.ports[key] <= 65535) ||
      new Set(Object.values(state.ports)).size !== 3) throw new Error('Invalid Team DevSpace state; use repair installation');
  state.gateway = normalizeGateway(state.gateway);
  state.currentProjectRoot = currentProjectRoot;
  delete state.roots;
  return state;
}

export async function writeUpstreamConfig(state, home = stateHome()) {
  // Team DevSpace exposes one current project. Upstream DevSpace keeps its native
  // allowedRoots array contract internally, always with exactly that one root.
  const currentProjectRoot = projectRootFromState(state);
  if (!currentProjectRoot) throw projectRootError('project_root_required', '请选择要让 Team DevSpace 操作的项目目录');
  await atomicJson(join(home, 'devspace', 'config.json'), {
    host: '127.0.0.1', port: state.ports.devspace, allowedRoots: [currentProjectRoot],
    publicBaseUrl: state.gateway, allowedHosts: ['127.0.0.1', 'localhost'],
    stateDir: join(home, 'upstream-state'), worktreeRoot: join(home, 'worktrees'),
    agentDir: join(home, 'agents'), subagents: { enabled: false, providers: [] }, artifactsEnabled: false,
  });
  await atomicJson(join(home, 'devspace', 'auth.json'), { ownerToken: state.ownerToken });
}

export function upstreamEnvironment(home = stateHome()) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEVSPACE_') && !['PORT', 'HOST'].includes(key)));
  return { ...env, DEVSPACE_CONFIG_DIR: join(home, 'devspace'), DEVSPACE_TOOL_MODE: 'minimal',
    DEVSPACE_WIDGETS: 'off', DEVSPACE_STATE_DIR: join(home, 'upstream-state'), DEVSPACE_WORKTREE_ROOT: join(home, 'worktrees'),
    DEVSPACE_AGENT_DIR: join(home, 'agents'), DEVSPACE_SUBAGENTS: 'false',
    DEVSPACE_LOG_LEVEL: 'error', DEVSPACE_LOG_REQUESTS: 'false', DEVSPACE_LOG_TOOL_CALLS: 'false',
    DEVSPACE_LOG_SHELL_COMMANDS: 'false', DEVSPACE_ARTIFACTS: 'false',
    DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: '127.0.0.1,localhost' };
}
