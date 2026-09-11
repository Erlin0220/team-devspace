async (page) => {
  // Run with the installed Playwright MCP after navigating to the loopback URL
  // printed by: node scripts/admin-ui-fixture.mjs start
  const origin = page.url().split('/').slice(0, 3).join('/');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Open the loopback admin UI fixture first');
  const context = await page.context().browser().newContext({ viewport: { width: 1100, height: 800 } });
  const p = await context.newPage();
  const checks = [];
  const errors = [];
  p.on('pageerror', error => errors.push(error.message));
  const check = (condition, name) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const requests = [];
  let releaseFirst;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  await p.route('**/admin/keys', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (requests.length === 1) {
      await firstResponse;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) });
    } else {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: body.id, label: body.label, state: 'issued' }) });
    }
  });
  try {
    await p.goto(`${origin}/admin`);
    await p.locator('#show-create').click();
    await p.locator('input[name="label"]').fill('Browser acceptance');
    await p.locator('#create-submit').click();
    await p.waitForFunction(() => document.querySelector('#create-submit').disabled);
    await p.locator('#close-dialog').click();
    await p.keyboard.press('Escape');
    await p.evaluate(() => document.querySelector('#create-key').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    check(await p.locator('#create-dialog').evaluate(dialog => dialog.open), 'creation cannot be closed or re-entered in flight');
    releaseFirst();
    await p.waitForFunction(() => !document.querySelector('#retry-key').hidden && !document.querySelector('#retry-key').disabled);
    check(requests.length === 1, 'duplicate submit produces one issuance request');
    check(await p.locator('#dismiss-key').isDisabled() && await p.locator('#copy-key').isDisabled(), 'failed creation cannot be acknowledged or distributed as confirmed');
    await p.locator('#dismiss-key').dispatchEvent('click');
    check(await p.evaluate(() => Boolean(sessionStorage.getItem('team-devspace.pending-access-key'))), 'failed acknowledgement retains the pending credential');
    await p.locator('#retry-key').click();
    await p.waitForFunction(() => !document.querySelector('#dismiss-key').disabled);
    check(requests.length === 2 && requests[0].id === requests[1].id && requests[0].keyHash === requests[1].keyHash,
      'retry reuses the original id and hash');
    check(requests.every(body => Object.keys(body).sort().join(',') === 'id,keyHash,label'), 'browser never sends plaintext credentials');
    await p.locator('#close-dialog').click();
    await p.locator('#show-create').click();
    check(await p.locator('#retry-key').isHidden() && await p.locator('#dismiss-key').isEnabled(), 'reopening a confirmed credential does not restart issuance');
    await p.reload();
    await p.waitForFunction(() => document.querySelector('#create-dialog').open);
    check(await p.locator('#dismiss-key').isEnabled(), 'confirmed acknowledgement survives reload');
    await p.setViewportSize({ width: 390, height: 844 });
    check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'admin page and credential dialog fit a narrow viewport');
    await p.locator('#dismiss-key').click();
    await p.waitForFunction(() => !document.querySelector('#notice').hidden);
    check((await p.locator('#notice').textContent()).includes('已创建') &&
      !await p.evaluate(() => Boolean(sessionStorage.getItem('team-devspace.pending-access-key'))), 'only a confirmed saved credential produces success and clears pending state');
    await p.setViewportSize({ width: 1100, height: 800 });
    let lifecycleAttempts = 0;
    await p.route('**/admin/keys/*/reset', async route => {
      lifecycleAttempts++;
      await route.fulfill({ status: lifecycleAttempts === 1 ? 401 : 503, contentType: 'application/json',
        body: JSON.stringify(lifecycleAttempts === 1 ? { error: 'access_required' }
          : { error: 'connectivity_cleanup_pending', cleanup: 'pending', retryable: true }) });
    });
    await p.locator('[data-key-action="reset"]').click();
    await p.locator('#confirm-action').click();
    await p.waitForFunction(() => !document.querySelector('#action-notice').hidden);
    check((await p.locator('#action-notice').textContent()).includes('登录已过期') &&
      await p.locator('#confirm-action').isEnabled(), 'expired administrator login yields actionable feedback and releases busy state');
    await p.locator('#confirm-action').click();
    await p.waitForFunction(() => !document.querySelector('#notice').hidden && document.querySelector('#notice').textContent.includes('自动继续清理'));
    check((await p.locator('#notice').textContent()).includes('暂未清理完成'), 'partial cloud cleanup is reported as pending, not completed');
    check(errors.length === 0, 'no browser script errors');
    await context.close();
    return { passed: true, checks, realBrowser: true, productionAssets: true, liveAdministrativeWrites: false };
  } catch (error) {
    releaseFirst();
    return { passed: false, checks, error: error.message, pageErrors: errors, fixtureUrl: p.url() };
  }
}
