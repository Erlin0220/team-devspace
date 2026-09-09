import { createRequire } from 'node:module';
import { createBridge } from './bridge.mjs';
import { DEVSPACE_VERSION, loadState, stateHome, upstreamEnvironment, writeUpstreamConfig } from './state.mjs';

const require = createRequire(import.meta.url);

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}

export async function startUpstream(state, home = stateHome()) {
  const installed = require('@waishnav/devspace/package.json');
  if (installed.version !== DEVSPACE_VERSION) throw new Error('Upstream DevSpace version differs from the release pin');
  await writeUpstreamConfig(state, home);
  const environment = upstreamEnvironment(home);
  for (const key of Object.keys(process.env)) if (key.startsWith('DEVSPACE_')) delete process.env[key];
  Object.assign(process.env, environment);
  const { loadConfig } = await import('@waishnav/devspace/dist/config.js');
  const { createServer } = await import('@waishnav/devspace');
  const config = loadConfig(environment);
  config.subagents.enabled = false;
  const application = createServer(config);
  const server = await new Promise((resolve, reject) => {
    const running = application.app.listen(config.port, config.host, () => resolve(running));
    running.once('error', reject);
  }).catch(async error => { await application.close(); throw error; });
  return { server, close: application.close };
}

export async function startBridge(state, home = stateHome()) {
  if (!state.bindingId) throw new Error('Complete Enrollment before starting the bridge');
  const server = await listen(createBridge(state, home), state.ports.bridge);
  return { server, close: async () => {} };
}

export async function closeService(service) {
  const closeHttp = new Promise((resolve, reject) => service.server.close(error => error ? reject(error) : resolve()));
  const timeout = setTimeout(() => service.server.closeAllConnections(), 2000);
  timeout.unref();
  try { await service.close(); await closeHttp; } finally { clearTimeout(timeout); }
}

export async function runComponent(component, home = stateHome()) {
  if (process.platform !== 'win32' && process.getuid?.() === 0) throw new Error('Run Team DevSpace as the employee, not root');
  const state = await loadState(home);
  if (component !== 'runtime') throw new Error('Unknown runtime component');
  const upstream = await startUpstream(state, home);
  let bridge;
  try { bridge = await startBridge(state, home); }
  catch (error) { await closeService(upstream); throw error; }
  const services = [upstream, bridge];
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await Promise.all(services.map(closeService)); process.exitCode = 0; }
    catch { process.exitCode = 1; for (const service of services) service.server.closeAllConnections(); }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdout.write(`${JSON.stringify({ event: 'listening', component, version: DEVSPACE_VERSION })}\n`);
  return { close: stop };
}
