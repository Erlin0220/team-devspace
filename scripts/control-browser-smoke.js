async (page) => {
  // Navigate the installed Playwright MCP to the URL printed by
  // node scripts/control-ui-fixture.mjs start, then run this file.
  const url = page.url();
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url.split('#')[0])) throw new Error('Open the isolated local Control Center fixture');
  const capability = await page.evaluate(() => sessionStorage.getItem('tds-control-token'));
  const context = await page.context().browser().newContext({ viewport: { width: 1100, height: 900 } });
  const p = await context.newPage(), errors = [], checks = [];
  p.on('pageerror', error => errors.push(error.message));
  const check = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  const confirm = () => p.once('dialog', dialog => dialog.accept());
  const settled = page => (page ?? p).waitForFunction(() => document.querySelector('#feedback')?.dataset.busy === 'false');
  const nav = name => p.locator(`[data-view-target="${name}"]`).click();
  try {
    await p.goto(`${url.split('#')[0]}#${capability}`);
    await settled();
    check(await p.locator('#windows-setup').isVisible(), 'Windows first-run setup uses the dedicated setup surface');
    check(await p.locator('#settings-normal').isHidden(), 'normal settings stay out of the first-run path');
    check(await p.locator('#setup-submit').textContent() === '完成设置并连接', 'first-run setup exposes one completion action');
    check(await p.evaluate(() => location.hash === ''), 'local capability is removed from visible URL history');
    await p.locator('#setup-access-key').fill(`tds_${'c'.repeat(43)}`);
    await p.locator('#setup-later').click();
    await nav('settings');
    check(await p.locator('#setup-access-key').inputValue() === '', 'leaving first-run settings clears an unsubmitted Key');
    await p.locator('#setup-choose-folder').click();
    await p.waitForFunction(() => document.querySelector('#setup-project-root').value.includes('project-selected'));
    await settled();
    await p.locator('#setup-access-key').fill(`tds_${'a'.repeat(43)}`);
    check(await p.locator('#setup-submit').isEnabled(), 'first-run completion requires both Key and project directory');
    await p.locator('#setup-submit').click();
    await p.waitForFunction(() => document.querySelector('#feedback').textContent.includes('正在处理本机设置'), null, { timeout: 2300 });
    check(await p.locator('#setup-submit').isDisabled(), 'controller progress stays visible while a real submission is pending');
    await settled();
    await p.waitForFunction(() => document.querySelector('#summary').textContent.includes('已连接'));
    check(await p.locator('#setup-access-key').inputValue() === '', 'successful enrollment clears the first-run key input');
    check(await p.locator('#windows-setup').isHidden() && await p.locator('#settings-normal').isVisible(), 'successful enrollment switches to normal settings');
    await nav('diagnostics');
    await p.locator('#diagnostics').click();
    await p.waitForFunction(() => !document.querySelector('#report').hidden);
    check(JSON.parse(await p.locator('#report').textContent()).calls.setup === 1, 'duplicate setup submission produces one transaction');
    await p.locator('#restart').click(); await settled(); await p.waitForTimeout(1800);
    check(!/正在|检查状态/.test(await p.locator('#feedback').textContent()), 'completed restart cannot leave progress text after subsequent polls');
    check(await p.locator('#feedback').getAttribute('data-busy') === 'false', 'completed restart stops the feedback spinner');
    await nav('overview');
    await p.locator('#remote').click(); await settled();
    check((await p.locator('#remote').textContent()).includes('恢复'), 'pause is rendered from the controller observed/desired state');
    check(await p.locator('body').getAttribute('data-client-state') === 'suspended', 'paused connection does not display a ready signal');
    check(await p.locator('#health .health-item[data-state="neutral"]').count() === 5,
      'intentionally stopped services and paused intent are neutral, not healthy green');
    await nav('settings');
    check(await p.locator('#restart').isDisabled(), 'restart cannot silently undo pause');
    check(await p.locator('#edit-key').isEnabled(), 'settings remain usable while remote access is paused');
    check(await p.locator('#manual-project').isHidden(), 'native Windows settings do not expose a redundant manual path editor');
    await p.locator('#choose-folder').click(); await settled();
    check((await p.locator('#current-root').textContent()).includes('project-picked'), 'one folder-selection action immediately applies the chosen project');
    await p.locator('#choose-folder').click(); await settled();
    check((await p.locator('#current-root').textContent()).includes('project-picked'), 'cancelled selection preserves the committed project');
    check((await p.locator('#feedback').textContent()).includes('已取消'), 'cancel is a normal outcome, not a connection error');
    check((await p.locator('#remote').textContent()).includes('恢复'), 'changing project does not resume remote access');
    await p.locator('#edit-key').click();
    await p.locator('#access-key').fill('invalid'); confirm(); await p.locator('#save-key').click(); await settled();
    await p.waitForTimeout(1700);
    check((await p.locator('#feedback').textContent()).includes('完整'), 'input validation error survives subsequent status polling');
    await p.locator('#access-key').fill(`tds_${'b'.repeat(43)}`); confirm(); await p.locator('#save-key').click(); await settled();
    check((await p.locator('#feedback').textContent()).includes('测试绑定失败'), 'failed key replacement remains actionable on the same page');
    check(!(await p.locator('#feedback').textContent()).includes(`tds_${'b'.repeat(43)}`), 'operation errors never echo Access Keys');
    await p.locator('#access-key').fill(`tds_${'a'.repeat(43)}`); confirm(); await p.locator('#save-key').click(); await settled();
    check(await p.locator('#access-key').inputValue() === '' && await p.locator('#key-form').isHidden(), 'successful key replacement clears and closes the editor');
    await p.goto(`${url.split('/').slice(0, 3).join('/')}/diagnostics#${capability}`); await settled();
    check(await p.locator('#diagnostics-title').evaluate(el => document.activeElement === el), 'tray diagnostics navigates to the same page section, not another implementation');
    await p.goto(`${url.split('/').slice(0, 3).join('/')}/about#${capability}`); await settled();
    check(await p.locator('#about-title').evaluate(el => document.activeElement === el), 'About uses the same local page and focuses its information');
    await nav('settings');
    check(await p.locator('#key-form').isHidden() && await p.locator('#edit-key').isVisible(), 'configured device keeps low-frequency key editing closed by default');
    await p.locator('#edit-key').click();
    await p.locator('#access-key').fill(`tds_${'c'.repeat(43)}`);
    await nav('overview');
    await nav('settings');
    check(await p.locator('#access-key').inputValue() === '' && await p.locator('#key-form').isHidden(), 'leaving settings clears an unsubmitted replacement Key');
    await p.reload(); await settled();
    check((await p.locator('#current-root').textContent()).includes('project-picked'), 'reload restores controller state without losing the local capability');
    check(await p.evaluate(() => !Object.values(localStorage).some(value => value.includes('tds_'))), 'Access Keys are never persisted in browser localStorage');

    const updateCases = [
      [{ available: false, required: false, checkedAt: '2026-09-15T00:54:00.000Z', automatic: true,
        policy: { stable: '0.2.5', minimumSupported: null, enforceAfter: null } },
      { state: 'current', badge: '当前 0.2.5', title: '当前已是最新版本', detail: '当前版本 0.2.5', enabled: false }],
      [{ available: true, required: false, checkedAt: '2026-09-15T00:54:00.000Z', automatic: true, requiresAuthorization: false,
        policy: { stable: '0.2.6', minimumSupported: null, enforceAfter: null } },
      { state: 'available', badge: '新版本 0.2.6', title: '新版本 0.2.6 可用', detail: '更新期间连接会短暂重启', enabled: true }],
      [{ available: true, required: false, checkedAt: '2026-09-15T00:54:00.000Z', automatic: true, requiresAuthorization: false,
        automaticResult: { deferred: true, message: '当前有远程任务，自动更新已延后' },
        policy: { stable: '0.2.6', minimumSupported: null, enforceAfter: null } },
      { state: 'available', badge: '新版本 0.2.6', title: '新版本 0.2.6 可用', detail: '自动更新已延后', enabled: true }],
      [{ available: true, required: true, checkedAt: '2026-09-15T00:54:00.000Z', automatic: true, requiresAuthorization: false,
        policy: { stable: '0.2.6', minimumSupported: '0.2.6', enforceAfter: '2026-09-14T00:00:00.000Z' } },
      { state: 'required', badge: '需要升级', title: '当前版本需要升级', detail: '最低支持 0.2.6', enabled: true }],
      [{ available: false, required: false, automatic: true, error: '无法获取更新策略，请检查网络后重试', policy: { stable: '0.2.5' } },
      { state: 'error', badge: '检查失败', title: '检查更新失败', detail: '无法获取更新策略', enabled: false }],
      [{ available: true, required: false, checkedAt: '2026-09-15T00:54:00.000Z', automatic: true, requiresAuthorization: false,
        lastInstall: { exitCode: 1 }, policy: { stable: '0.2.6', minimumSupported: null, enforceAfter: null } },
      { state: 'available', badge: '新版本 0.2.6', title: '新版本 0.2.6 可用', detail: '上次安装未完成', enabled: true }],
    ];
    for (const [updates, expected] of updateCases) {
      const updatePage = await context.newPage();
      updatePage.on('pageerror', error => errors.push(error.message));
      await updatePage.route('**/api/state', async route => {
        const response = await route.fetch();
        const data = await response.json();
        data.updates = updates;
        await route.fulfill({ response, json: data });
      });
      await updatePage.goto(`${url.split('/').slice(0, 3).join('/')}/updates#${capability}`);
      await settled(updatePage);
      check(await updatePage.locator('#update-confirmation').isHidden(), 'background discovery never opens the confirmation modal');
      check(await updatePage.locator('#update-state-icon').getAttribute('data-state') === expected.state,
        `update UI renders ${expected.state} state icon`);
      check((await updatePage.locator('#update-version').textContent()) === expected.badge,
        `update UI renders ${expected.badge} badge`);
      check((await updatePage.locator('#update-description').textContent()) === expected.title,
        `update UI renders ${expected.title} title`);
      check((await updatePage.locator('#update-detail').textContent()).includes(expected.detail),
        `update UI preserves ${expected.detail} detail`);
      check((await updatePage.locator('#update-apply').isEnabled()) === expected.enabled,
        `update action availability matches ${expected.state}`);
      await updatePage.close();
    }

    const origin = new URL(url).origin;
    const sibling = await context.newPage();
    await sibling.goto(origin + '/updates#' + capability); await settled(sibling);
    await p.goto(origin + '/updates#' + capability); await settled();
    check(await p.locator('#update-confirmation').isHidden(), 'opening Updates does not treat background state as a manual check');
    // Hold a pre-check snapshot until the action response has arrived. The
    // initiating page must await a fresh read instead of losing its modal.
    let releaseOldPoll, markOldPoll, holdOldPoll = true;
    const oldPollReleased = new Promise(resolve => { releaseOldPoll = resolve; });
    const oldPollCaptured = new Promise(resolve => { markOldPoll = resolve; });
    await p.route('**/api/state', async route => {
      if (!holdOldPoll) return route.continue();
      holdOldPoll = false;
      const response = await route.fetch(), json = await response.json();
      markOldPoll(); await oldPollReleased; await route.fulfill({ response, json });
    });
    await p.bringToFront();
    await Promise.race([oldPollCaptured, p.waitForTimeout(6000).then(() => { throw new Error('Status poll was not captured'); })]);
    const checkedResponse = p.waitForResponse(response => response.url().endsWith('/api/action'));
    await p.locator('#update-check').click(); await checkedResponse;
    await p.waitForTimeout(100); releaseOldPoll();
    await p.locator('#update-confirmation').waitFor({ state: 'visible' });
    await p.unroute('**/api/state');
    check(true, 'manual discovery survives an overlapping stale status response');
    await p.waitForFunction(() => document.querySelectorAll('#update-modal-notes li').length === 2);
    check((await p.locator('#update-modal-detail').textContent()).includes('当前版本 0.2.5') &&
      (await p.locator('#update-modal-detail').textContent()).includes('目标版本 0.2.6'), 'manual discovery modal correlates current and target versions');
    check(await p.locator('#update-modal-notes li').count() === 2, 'manual discovery modal renders bounded key notes as text');
    await sibling.waitForTimeout(1700);
    check(await sibling.locator('#update-confirmation').isHidden(), 'a manual check never opens a modal in another tab');
    await p.locator('#update-confirm').focus(); await p.keyboard.press('Tab');
    check(await p.evaluate(() => document.activeElement.id === 'update-modal-notes-link'), 'Tab stays inside the confirmation dialog');
    await p.keyboard.press('Shift+Tab');
    check(await p.evaluate(() => document.activeElement.id === 'update-confirm'), 'reverse Tab stays inside the confirmation dialog');
    await p.screenshot({ path: 'control-update-modal-desktop.png', fullPage: true });
    await p.setViewportSize({ width: 390, height: 844 });
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'update modal fits a narrow viewport');
    await p.screenshot({ path: 'control-update-modal-mobile.png', fullPage: true });
    await p.setViewportSize({ width: 1100, height: 900 });
    await p.locator('#update-later').click();
    check(await p.locator('#update-confirmation').isHidden(), 'Later closes the modal without installing');
    check(await p.evaluate(() => document.activeElement.id === 'update-check'), 'closing the modal restores focus to its trigger');

    const notesFailure = await context.newPage();
    await notesFailure.route('**/api/release-notes?*', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ version: '0.2.6', summary: null, error: 'Temporary notes failure',
        url: 'https://downloads.example.com/releases/0.2.6/release-notes.txt' }) }));
    await notesFailure.goto(origin + '/updates#' + capability); await settled(notesFailure);
    await notesFailure.locator('#update-apply').click();
    await notesFailure.locator('#update-modal-notes-fallback').waitFor({ state: 'visible' });
    check(await notesFailure.locator('#update-confirm').isEnabled(), 'notes failure does not block a confirmed update');
    check((await notesFailure.locator('#update-modal-notes-link').getAttribute('href')).includes('/0.2.6/release-notes.txt'), 'notes failure preserves the complete versioned release-notes link');
    await notesFailure.locator('#update-later').click(); await notesFailure.close();

    await p.locator('#update-apply').click(); await p.locator('#update-confirmation').waitFor({ state: 'visible' });
    await p.locator('#update-confirm').click(); await settled();
    check((await p.locator('#feedback').textContent()).includes('已取消软件更新'), 'cancelled handoff returns to the same page without stale installing state');
    await p.locator('#update-check').click(); await settled();
    check(await p.locator('#update-confirmation').isHidden(), 'manual latest-version result never opens the modal');
    check((await p.locator('#feedback').textContent()).includes('当前已是最新版本'), 'manual latest-version result uses a temporary notice');
    await p.waitForFunction(() => document.querySelector('#feedback').hidden, {}, { timeout: 9000 });
    check(await p.locator('#feedback').isHidden(), 'latest-version feedback really disappears while normal polling continues');
    await sibling.close();

    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'desktop layout has no horizontal overflow');
    await p.screenshot({ path: 'control-center-desktop.png', fullPage: true });
    await p.setViewportSize({ width: 390, height: 844 }); await p.emulateMedia({ colorScheme: 'dark' });
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow dark-mode layout remains usable');
    await p.screenshot({ path: 'control-center-mobile.png', fullPage: true });
    check(errors.length === 0, 'no browser JavaScript errors');
    return { passed: true, checks, realBrowser: true, productionAssets: true, sharedController: true, liveDeviceWrites: false };
  } catch (error) {
    return { passed: false, checks, error: error.message, pageErrors: errors };
  } finally { await context.close(); }
}
