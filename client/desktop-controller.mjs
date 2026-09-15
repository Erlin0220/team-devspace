import { notifyObserver } from './operation.mjs';
import { diagnosticReport, openLogs, restartTeamDevSpace, resumeRemoteAccess,
  stopTeamDevSpace, suspendRemoteAccess } from './control.mjs';
import { changeProjectRoot, configureFromDesktop, desktopLocalState, deviceStatus,
  promptProjectRoot, repairDevice, replaceAccessKey } from './setup.mjs';
import { desktopErrorText, macProgress } from './desktop.mjs';
import { stateHome } from './state.mjs';
import { desktopState } from './desktop-state.mjs';
import { createGatewayStatusProbe } from './gateway-status.mjs';
import { updateStatus, checkForUpdates, applyUpdate, fetchReleaseNotes, releaseNotesUrl, setAutomaticUpdates, startUpdateChecks } from './updates.mjs';
export { desktopState } from './desktop-state.mjs';

const ACTIVITY = {
  suspend: '正在暂停远程访问…', resume: '正在恢复远程访问…', restart: '正在重启连接服务…',
  repair: '正在修复连接…', 'project-root': '正在切换项目目录…',
  'switch-key': '正在设置 Access Key…', setup: '正在完成设置…',
  'update-check': '正在检查软件更新…', 'update-apply': '正在准备软件更新…', 'update-auto': '正在保存更新偏好…',
};
const SUCCESS = {
  suspend: '暂停操作已完成', resume: '恢复操作已完成', restart: '连接服务重启操作已完成',
  repair: '修复操作已完成', 'project-root': '项目目录已更改，请重新连接 ChatGPT',
  'switch-key': 'Access Key 已更新', setup: '设置已完成',
  'update-check': '软件更新检查完成', 'update-apply': '更新已交给系统安装器；完成后请重新打开设置', 'update-auto': '更新偏好已保存',
};

export function createDesktopController(home = stateHome(), options = {}) {
  const gatewayStatus = createGatewayStatusProbe();
  const operations = options.operations ?? {
    status: async ({ forceGateway = false } = {}) => {
      try { return await deviceStatus(home, { gatewayStatus, forceGateway }); }
      catch (error) { if (!(await desktopLocalState(home)).configured) return null; throw error; }
    }, localState: () => desktopLocalState(home),
    suspend: ({ onProgress }) => suspendRemoteAccess(home, { onProgress }),
    resume: ({ onProgress }) => resumeRemoteAccess(home, { onProgress }),
    restart: ({ onProgress }) => restartTeamDevSpace(home, { onProgress }),
    repair: ({ onProgress }) => repairDevice(home, { preserveTray: true, onProgress }),
    setup: ({ accessKey, projectRoot, onProgress }) => configureFromDesktop(home,
      { input: { accessKey, currentProjectRoot: projectRoot }, startup: true, onProgress }),
    'switch-key': ({ accessKey, onProgress }) => replaceAccessKey(accessKey, home, { onProgress }),
    'project-root': ({ projectRoot, onProgress }) => changeProjectRoot(projectRoot, home, { onProgress }),
    'choose-folder': ({ signal, projectRoot }) => promptProjectRoot(projectRoot, { signal, home }),
    logs: () => openLogs(home), diagnostics: () => diagnosticReport(home),
    'update-check': ({ signal }) => checkForUpdates(home, { force: true, signal }),
    'release-notes': async ({ version, signal }) => {
      try { return await fetchReleaseNotes(version, { signal }); }
      catch { return { version, summary: null, url: releaseNotesUrl(version), error: '暂时无法读取更新说明' }; }
    },
    'update-apply': ({ onProgress, signal, confirmedVersion }) => applyUpdate(home, { onProgress, signal, confirmedVersion }),
    'update-auto': ({ enabled }) => setAutomaticUpdates(enabled, home),
    exit: () => stopTeamDevSpace(home),
  };
  let status = null, local = {}, activity = '正在启动…', notice, failure, probeFailure, noticeTimer;
  let revision = 0, pending = null, refreshPromise = null, closing = false, disposed = false, interval;
  let started = false, checkedAt = null, refreshForced = false, updates = null, stopUpdates, failureAction;
  const clearNotice = () => { clearTimeout(noticeTimer); noticeTimer = undefined; notice = undefined; };
  const setNotice = (message, persistent = false) => {
    clearNotice(); notice = message;
    if (!message || persistent) return;
    noticeTimer = setTimeout(() => { noticeTimer = undefined; notice = undefined; publish(); }, options.noticeTtl ?? 6000);
    noticeTimer.unref?.();
  };
  const refreshUpdates = async (generation = revision) => {
    if (!options.operations) {
      const value = await updateStatus(home).catch(() => null);
      if (value && generation === revision && !disposed) {
        updates = value;
      }
      publish();
    }
  };
  const listeners = new Set();
  const utilities = new Map();
  const releaseNotesCache = new Map();
  let prompts = new AbortController();
  const snapshot = () => ({ ...desktopState(status, { ...local, busy: Boolean(pending) || utilities.has('choose-folder') || closing,
    exiting: closing, activity: !closing && utilities.has('choose-folder') ? '正在选择项目目录…' : activity,
    notice, alert: failure ?? probeFailure, updates }), checkedAt, updates });
  const publish = () => { if (!disposed) for (const listener of listeners) notifyObserver(listener, snapshot()); };
  const readLocal = async () => {
    const generation = revision;
    if (!operations.localState) return;
    const value = await operations.localState();
    if (generation === revision && !disposed) local = value;
  };
  const refresh = (forceGateway = false) => {
    if (pending || closing || disposed) return Promise.resolve(snapshot());
    if (refreshPromise) return forceGateway && !refreshForced
      ? refreshPromise.then(() => refresh(true)) : refreshPromise;
    refreshForced = forceGateway;
    const generation = revision;
    refreshPromise = Promise.resolve().then(() => operations.status({ forceGateway })).then(value => {
      if (generation === revision && !disposed) { status = value; probeFailure = undefined; checkedAt = new Date().toISOString(); }
    }, error => {
      if (generation === revision && !disposed) { status = null; probeFailure = desktopErrorText(error); }
    }).finally(async () => {
      await refreshUpdates(generation);
      refreshPromise = null;
      if (generation === revision && !disposed) { activity = undefined; publish(); }
    });
    return refreshPromise;
  };
  const dispatch = async (action, input = {}) => {
    if (disposed || closing) throw Object.assign(new Error('正在退出 Team DevSpace'), { status: 409 });
    if (action === 'check') {
      const generation = revision;
      if (!pending) { clearNotice(); activity = '正在检查连接…'; publish(); }
      await refresh(true);
      if (generation === revision && !pending && !closing) {
        activity = undefined;
        if ((snapshot().status === 'ready' && ['resume', 'restart', 'repair'].includes(failureAction)) ||
            (failureAction === 'suspend' && status?.gateway === 'suspended' && status?.desiredRemoteAccess === 'suspended')) {
          failure = undefined; failureAction = undefined;
        }
        setNotice(snapshot().status === 'ready' ? '连接检查完成，一切正常' : '连接检查完成，请查看当前状态');
        publish();
      }
      return snapshot();
    }
    if (action === 'exit') {
      closing = true; revision++; activity = '正在停止服务并退出…'; publish();
      prompts.abort();
      try {
        // Finish an already-started binding transaction before stopping services.
        // An unrelated health probe or open browser never gates shutdown.
        await pending?.catch(() => {});
        await operations.exit();
        return { stopped: true };
      } catch (error) {
        closing = false; activity = undefined; failureAction = 'exit'; failure = `关闭 Team DevSpace失败：${desktopErrorText(error)}`;
        publish(); throw error;
      }
    }
    if (action === 'release-notes') {
      const notes = operations[action] ?? (async ({ version, signal }) => {
        try { return await fetchReleaseNotes(version, { signal }); }
        catch { return { version, summary: null, url: releaseNotesUrl(version), error: '暂时无法读取更新说明' }; }
      });
      if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(input.version ?? '')) throw Object.assign(new Error('更新版本无效'), { status: 400 });
      if (!releaseNotesCache.has(input.version) && releaseNotesCache.size >= 4) releaseNotesCache.delete(releaseNotesCache.keys().next().value);
      if (!releaseNotesCache.has(input.version)) releaseNotesCache.set(input.version,
        Promise.resolve().then(() => notes({ ...input, signal: prompts.signal })));
      return releaseNotesCache.get(input.version);
    }
    if (['logs', 'diagnostics', 'choose-folder'].includes(action)) {
      if (!operations[action]) throw new Error('不支持的操作');
      if (utilities.has(action)) return utilities.get(action);
      if (action === 'choose-folder') { failure = undefined; clearNotice(); }
      if (prompts.signal.aborted) prompts = new AbortController();
      const task = Promise.resolve().then(() => operations[action]({ ...input, signal: prompts.signal }))
        .then(result => { if (action === 'logs' && !closing) setNotice('已打开日志目录'); return result; })
        .catch(error => { failureAction = action; failure = desktopErrorText(error); publish(); throw error; })
        .finally(() => { utilities.delete(action); publish(); });
      utilities.set(action, task); publish();
      return task;
    }
    if (!Object.hasOwn(ACTIVITY, action) || !operations[action]) throw Object.assign(new Error('未知控制操作'), { status: 400 });
    if (pending || utilities.has('choose-folder')) throw Object.assign(new Error('已有操作正在进行，请等待完成'), { status: 409 });
    revision++; gatewayStatus.invalidate(); failure = undefined; failureAction = undefined; clearNotice(); activity = ACTIVITY[action];
    if (action === 'update-check') releaseNotesCache.clear();
    pending = Promise.resolve().then(async () => {
      let parameters = input;
      // Selecting a replacement is one controller operation. Cancellation never
      // commits a path, and exit can cancel the prompt before a transaction starts.
      if (action === 'project-root' && input.projectRoot === undefined) {
        activity = '正在选择项目目录…'; publish();
        const projectRoot = await dispatch('choose-folder', { projectRoot: status?.currentProjectRoot ?? local.currentProjectRoot });
        if (!projectRoot || closing || prompts.signal.aborted) {
          if (!closing) setNotice('已取消更换项目目录');
          return { cancelled: true };
        }
        parameters = { ...input, projectRoot };
        activity = ACTIVITY[action]; publish();
      }
      const result = await operations[action]({ ...parameters, signal: prompts.signal,
        onProgress: message => { if (!closing) { activity = macProgress(message); publish(); } } });
      // A failed projection cannot turn a committed operation into a retryable failure.
      await readLocal().catch(() => {});
      if (action === 'update-check') {
        updates = result;
      } else if (action.startsWith('update-')) await refreshUpdates();
      if (!closing) {
        try {
          // An Enrollment acknowledgement is not a runtime health snapshot.
          status = typeof result?.devspace === 'boolean' && typeof result?.gateway === 'string'
            ? result : await operations.status({ forceGateway: true });
          probeFailure = undefined;
        } catch (error) { status = null; probeFailure = desktopErrorText(error); }
        if (action === 'update-apply') {
          if (result?.cancelled) setNotice('已取消软件更新');
          else if (result?.handedOff) setNotice(result.requiresAuthorization
            ? '系统安装器已打开，正在等待授权或安装；本页面会在服务恢复后自动重新连接'
            : '系统安装器已启动，正在安装并等待服务重新连接');
          else if (result?.deferred) setNotice(result.message ?? '更新已准备，将在本机空闲后继续');
          else setNotice('当前没有需要安装的新版本');
        } else if (action === 'update-check') {
          if (!result?.available && !result?.error && result?.checkedAt && result?.policy?.stable) setNotice('当前已是最新版本');
        } else if (!result?.cancelled) setNotice(result?.warning ?? (action === 'project-root' && result?.changed === false ? '项目目录未更改' : SUCCESS[action]));
        checkedAt = new Date().toISOString();
      }
      return result;
    }).catch(async error => {
      failureAction = action; failure = desktopErrorText(error); publish();
      // A failed operation may still persist a safety intent or partial binding.
      await readLocal().catch(() => {});
      if (!closing) {
        try { status = await operations.status({ forceGateway: true }); } catch { status = null; }
      }
      throw error;
    }).finally(() => {
      gatewayStatus.invalidate();
      pending = null;
      if (!closing) { activity = undefined; publish(); }
    });
    publish();
    return pending;
  };
  return {
    snapshot, dispatch,
    subscribe(listener) { listeners.add(listener); notifyObserver(listener, snapshot()); return () => listeners.delete(listener); },
    start() {
      if (started) return;
      started = true;
      void readLocal().then(publish, error => { failure = desktopErrorText(error); publish(); });
      void refresh(true);
      void refreshUpdates();
      if (!options.operations) stopUpdates = startUpdateChecks(home, () => void refreshUpdates(), () => !pending && !closing && !utilities.size);
      interval = setInterval(() => void refresh(), options.refreshInterval ?? 5000);
      interval.unref();
    },
    async dispose() {
      disposed = true; clearInterval(interval); clearTimeout(noticeTimer); stopUpdates?.(); prompts.abort(); listeners.clear();
      await pending?.catch(() => {});
    },
  };
}
