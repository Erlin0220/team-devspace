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
  const settled = () => p.waitForFunction(() => !document.querySelector('#save-key').disabled);
  try {
    await p.goto(`${url.split('#')[0]}#${capability}`);
    await settled();
    check(await p.locator('#save-key').textContent() === '完成设置并连接', 'first-run setup is available while runtime is unconfigured');
    check(await p.evaluate(() => location.hash === ''), 'local capability is removed from visible URL history');
    await p.locator('#choose-folder').click();
    await p.waitForFunction(() => document.querySelector('#project-root').value.includes('project-selected'));
    await settled();
    await p.locator('#access-key').fill(`tds_${'a'.repeat(43)}`);
    await p.locator('#save-key').click();
    await p.waitForFunction(() => document.querySelector('#save-key').disabled);
    await p.locator('#key-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await p.waitForFunction(() => document.querySelector('#feedback').textContent.includes('正在处理本机设置'), null, { timeout: 2300 });
    check(await p.locator('#save-key').isDisabled(), 'controller progress stays visible while a real submission is pending');
    await settled();
    await p.waitForFunction(() => document.querySelector('#summary').textContent.includes('已连接'));
    check(await p.locator('#access-key').inputValue() === '', 'successful enrollment clears the key input');
    await p.locator('#diagnostics').click();
    await p.waitForFunction(() => !document.querySelector('#report').hidden);
    check(JSON.parse(await p.locator('#report').textContent()).calls.setup === 1, 'duplicate setup submission produces one transaction');
    await p.locator('#restart').click(); await settled(); await p.waitForTimeout(1800);
    check(!/正在|检查状态/.test(await p.locator('#feedback').textContent()), 'completed restart cannot leave progress text after subsequent polls');
    check(await p.locator('#feedback').getAttribute('data-busy') === 'false', 'completed restart stops the feedback spinner');
    await p.locator('#remote').click(); await settled();
    check((await p.locator('#remote').textContent()).includes('恢复'), 'pause is rendered from the controller observed/desired state');
    check(await p.locator('#restart').isDisabled(), 'restart cannot silently undo pause');
    check(await p.locator('#save-key').isEnabled(), 'settings remain usable while remote access is paused');
    check(await p.locator('#manual-project').getAttribute('open') === null, 'normal directory changes do not require a draft input or separate Save button');
    await p.locator('#choose-folder').click(); await settled();
    check((await p.locator('#current-root').textContent()).includes('project-picked'), 'one folder-selection action immediately applies the chosen project');
    await p.locator('#choose-folder').click(); await settled();
    check((await p.locator('#current-root').textContent()).includes('project-picked'), 'cancelled selection preserves the committed project');
    check((await p.locator('#feedback').textContent()).includes('已取消'), 'cancel is a normal outcome, not a connection error');
    await p.locator('#manual-project summary').click();
    await p.locator('#project-root').fill('C:\\fixture\\project-b'); confirm(); await p.locator('#save-project').click(); await settled();
    check((await p.locator('#current-root').textContent()).includes('project-b'), 'project change is reflected in the shared snapshot');
    check((await p.locator('#remote').textContent()).includes('恢复'), 'changing project does not resume remote access');
    await p.locator('#access-key').fill('invalid'); confirm(); await p.locator('#save-key').click(); await settled();
    await p.waitForTimeout(1700);
    check((await p.locator('#feedback').textContent()).includes('完整'), 'input validation error survives subsequent status polling');
    await p.locator('#access-key').fill(`tds_${'b'.repeat(43)}`); confirm(); await p.locator('#save-key').click(); await settled();
    check((await p.locator('#feedback').textContent()).includes('测试绑定失败'), 'failed key replacement remains actionable on the same page');
    check(!(await p.locator('#feedback').textContent()).includes(`tds_${'b'.repeat(43)}`), 'operation errors never echo Access Keys');
    await p.locator('#access-key').fill(`tds_${'a'.repeat(43)}`); confirm(); await p.locator('#save-key').click(); await settled();
    check(await p.locator('#access-key').inputValue() === '', 'key replacement can be retried without reopening a modal');
    await p.goto(`${url.split('/').slice(0, 3).join('/')}/diagnostics#${capability}`); await settled();
    check(await p.locator('#diagnostics-title').evaluate(el => document.activeElement === el), 'tray diagnostics navigates to the same page section, not another implementation');
    await p.goto(`${url.split('/').slice(0, 3).join('/')}/about#${capability}`); await settled();
    check(await p.locator('#about-title').evaluate(el => document.activeElement === el), 'About uses the same local page and focuses its information');
    check(await p.locator('#key-settings').getAttribute('open') === null, 'configured device keeps low-frequency key controls collapsed');
    await p.reload(); await settled();
    check((await p.locator('#current-root').textContent()).includes('project-b'), 'reload restores controller state without losing the local capability');
    check(await p.evaluate(() => !Object.values(localStorage).some(value => value.includes('tds_'))), 'Access Keys are never persisted in browser localStorage');
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
