import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createDesktopController } from './desktop-controller.mjs';
import { findMenuAction } from './desktop-state.mjs';
import { startLocalControl } from './local-control.mjs';
import { stateHome } from './state.mjs';
import { desktopErrorText, trayExecutable, trayInstanceId } from './desktop.mjs';
export { trayExecutable, trayInstanceId } from './desktop.mjs';
// Retained for existing status consumers; there is only one presentation implementation.
export { desktopState as trayState } from './desktop-controller.mjs';

// Native adapters render a shared menu and emit an action. They neither probe
// services nor own settings dialogs, credentials, operation state or recovery.
export async function runTray(home = stateHome(), options = {}) {
  const controller = options.controller ?? createDesktopController(home, options);
  const child = spawn(options.helper ?? trayExecutable(options.root), options.helperArgs ?? [], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEAM_DEVSPACE_TRAY_INSTANCE_ID: await trayInstanceId(home) },
  });
  let closed = false, visible = false, duplicate = false, exiting = false, ready = false;
  let controlSurface, controlStarting, opening, shutdownTimer, unsubscribe;
  const requireVisible = options.requireVisible ?? (process.platform === 'darwin' && !options.helper);
  const startupTimer = requireVisible ? setTimeout(() => {
    if (!visible && !duplicate && !closed) child.kill();
  }, options.startupTimeout ?? 10000) : undefined;
  startupTimer?.unref();
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const send = state => {
    if (!closed && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(`${JSON.stringify(state)}\n`);
  };
  const ensureControlSurface = () => {
    if (controlSurface) return Promise.resolve(controlSurface);
    if (!controlStarting) controlStarting = (options.startLocalControl ?? startLocalControl)(controller, { home })
      .then(value => {
        controlSurface = value;
        if (value.endpointPersisted === false && value.port) {
          process.stderr.write('[Team DevSpace desktop] Control Center endpoint could not be persisted; this run remains usable.\n');
        }
        if (value.migratedFrom) {
          process.stderr.write(`[Team DevSpace desktop] Control Center moved from 127.0.0.1:${value.migratedFrom} to 127.0.0.1:${value.port}; the previous port stayed occupied.\n`);
          if (!options.openSettings) void value.open().catch(error => {
            process.stderr.write(`[Team DevSpace desktop] Open migrated Control Center: ${desktopErrorText(error)}\n`);
          });
        }
        return value;
      }, error => {
        process.stderr.write(`[Team DevSpace desktop] Control Center unavailable: ${desktopErrorText(error)}\n`);
        throw error;
      }).finally(() => { if (!controlSurface) controlStarting = undefined; });
    return controlStarting;
  };
  const openSettings = section => {
    if (opening) return opening;
    opening = (async () => {
      await ensureControlSurface();
      await controlSurface.open(section);
    })().finally(() => { opening = undefined; });
    return opening;
  };
  const onMenu = async action => {
    // Authorize against the same menu snapshot both native adapters display.
    const item = findMenuAction(controller.snapshot().menu, action);
    if (!item || exiting || closed) return;
    try {
      if (['settings', 'troubleshoot', 'about', 'updates'].includes(action)) {
        await openSettings(action === 'troubleshoot' ? 'diagnostics' : ['about', 'updates'].includes(action) ? action : undefined);
      }
      else if (action === 'exit') {
        exiting = true;
        try { await controller.dispatch('exit'); }
        catch (error) { exiting = false; throw error; }
        child.stdin.end();
        shutdownTimer = setTimeout(() => { if (!closed) child.kill(); }, 3000);
        shutdownTimer.unref();
      } else await controller.dispatch(action);
    } catch (error) {
      process.stderr.write(`[Team DevSpace desktop] ${action}: ${desktopErrorText(error)}\n`);
      // Persistent errors are visible in the controller snapshot, not repeated
      // modal native alerts that can block the menu or hide operation progress.
      if (!['settings', 'troubleshoot', 'about', 'updates'].includes(action) && !exiting && !closed) await openSettings().catch(() => {});
    }
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.event === 'ready' && !ready) {
        ready = true;
        void ensureControlSurface().catch(() => {});
        unsubscribe = controller.subscribe(send);
        controller.start();
        if (options.openSettings) void openSettings().catch(error => {
          process.stderr.write(`[Team DevSpace desktop] Open setup: ${desktopErrorText(error)}\n`);
        });
      } else if (event.event === 'tray-visible') { visible = true; clearTimeout(startupTimer); }
      else if (event.event === 'duplicate') { duplicate = true; clearTimeout(startupTimer); }
      else if (event.event === 'protocol-error') process.stderr.write('[Team DevSpace desktop] Native protocol error\n');
      else if (event.event === 'menu' && typeof event.action === 'string') void onMenu(event.action);
    } catch { process.stderr.write('[Team DevSpace desktop] Invalid native event\n'); }
  });
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { closed = true; resolve({ code, signal }); });
    });
    if (requireVisible && !visible && !duplicate) throw new Error('Native macOS tray exited before its menu bar item became visible');
    if (!exiting && (exit.signal || exit.code !== 0)) throw new Error(`Native tray exited unexpectedly (${exit.signal ?? exit.code})`);
  } finally {
    closed = true; clearTimeout(startupTimer); clearTimeout(shutdownTimer); unsubscribe?.(); lines.close();
    await controller.dispose();
    await opening?.catch(() => {});
    await controlStarting?.catch(() => {});
    if (controlSurface) await controlSurface.close().catch(error => {
      process.stderr.write(`[Team DevSpace desktop] Close Control Center: ${desktopErrorText(error)}\n`);
    });
  }
}
