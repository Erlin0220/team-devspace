// Run this function through the existing Playwright browser_run_code_unsafe code option.
// Use an isolated headless page if the shared browser is hidden/occluded. No installers run.
// Open either the routed local preview or the real homepage first.
async (page) => {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => location.origin);
  check(origin.startsWith('https://'), 'Open the download homepage first');
  const results = { url: page.url(), widths: [], checks: [], packages: [] };
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'none' });
  check(await page.locator('h1').count() === 1, 'One semantic page heading');
  check(await page.locator('.platform-card').count() === 4, 'All four download targets visible');
  check(await page.locator('script[src$="/download-site.js"]').count() === 1, 'Only the tiny copy helper script is allowed');
  check(await page.locator('img.brand-mark[src$="/devspace-logo-light.png"]').count() === 2, 'Header and footer must use the product logo');
  const anchors = await page.locator('a[href^="#"]').evaluateAll(links => links.map(a => ({ href: a.getAttribute('href'), exists: Boolean(document.querySelector(a.getAttribute('href'))) })));
  check(anchors.every(a => a.exists), 'Every internal link must have a target');
  for (const width of [320, 375, 390, 600, 768, 1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const links = [...document.querySelectorAll('a,summary')].filter(el => el.getClientRects().length && !el.classList.contains('skip'));
      return { viewport: root.clientWidth, scroll: root.scrollWidth,
        outside: links.filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > root.clientWidth + 1; }).map(el => el.textContent.trim()) };
    });
    check(layout.scroll <= layout.viewport + 1, `Horizontal overflow at ${width}px`);
    check(layout.outside.length === 0, `Clipped interaction at ${width}px: ${layout.outside.join(', ')}`);
    results.widths.push({ width, overflow: false });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  check(await page.locator('#pause-motion,.motion-toggle').count() === 0, 'No manual motion controls');
  check(await page.locator('.light-ribbon').first().evaluate(el => getComputedStyle(el).animationPlayState) === 'running', 'Hero motion runs by default');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check(await page.locator('.light-ribbon').first().evaluate(el => getComputedStyle(el).animationName) === 'none', 'Reduced motion must disable animation');
  results.checks.push('default hero motion', 'reduced motion');
  for (const detail of await page.locator('.faq-list details').all()) {
    const before = await detail.evaluate(el => el.open);
    await detail.locator('summary').click();
    check(await detail.evaluate(el => el.open) === !before, 'Native FAQ must toggle');
    await detail.locator('summary').click();
  }
  const navCta = page.locator('.nav-cta');
  await navCta.hover();
  check(await navCta.evaluate(el => getComputedStyle(el).color === 'rgb(21, 20, 23)'), 'Header CTA text remains readable on hover');
  await navCta.click();
  check(await page.evaluate(() => location.hash) === '#download', 'Primary navigation must reach downloads');
  const security = page.locator('details').filter({ has: page.locator('#security') });
  if (await security.evaluate(el => el.open)) await security.locator('summary').click();
  await page.getByRole('link', { name: '了解安装与安全边界' }).click();
  check(await security.evaluate(el => el.open), 'Linking to security must reveal even a previously closed disclosure');
  results.checks.push('header CTA hover', 'native FAQ open/close', 'download navigation', 'visible security disclosure');
  const firstCopy = page.locator('.copy-button').first();
  await firstCopy.click();
  check(await firstCopy.locator('.copy-label').textContent() === '已复制', 'Copy command button must confirm success');
  results.checks.push('copy command');
  await page.emulateMedia({ forcedColors: 'active' });
  const textColors = await page.locator('.headline-top,.hero-word').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).color));
  check(textColors.every(color => color !== 'rgba(0, 0, 0, 0)'), 'Heading must remain readable in forced colors');
  results.checks.push('forced-colors heading fallback');
  await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
  const remote = await page.request.get(`${origin}/catalog.json`, { timeout: 20000 });
  check(remote.status() === 200, 'Active catalog reachable');
  const catalog = await remote.json();
  for (const card of await page.locator('.platform-card').all()) {
    const target = await card.getAttribute('id');
    const href = await card.locator('.package-button').getAttribute('href');
    const checksumUrl = await card.locator('.checksum').getAttribute('href');
    const asset = catalog.targets[target];
    check(Boolean(asset), `Catalog target missing: ${target}`);
    const [head, range, hash] = await Promise.all([
      page.request.head(href, { timeout: 20000 }),
      page.request.get(href, { headers: { Range: 'bytes=0-15', 'Accept-Encoding': 'identity' }, timeout: 20000 }),
      page.request.get(checksumUrl, { timeout: 20000 }),
    ]);
    check(head.status() === 200 && Number(head.headers()['content-length']) === asset.size, `${target} download identity`);
    check(Boolean(head.headers().etag), `${target} ETag`);
    check(range.status() === 206 && (await range.body()).length === 16 && range.headers()['content-range'] === `bytes 0-15/${asset.size}`, `${target} resumable download`);
    check(hash.status() === 200 && (await hash.text()).trim() === asset.sha256, `${target} checksum sidecar`);
    results.packages.push({ target, size: asset.size, head: 200, range: 206, checksum: true });
  }
  const metadataLinks = await page.locator('.release-links a').evaluateAll(links => [...new Set(links.map(a => a.href).filter(url => !new URL(url).hash))]);
  for (const url of metadataLinks) {
    const response = await page.request.head(url, { timeout: 20000 });
    check(response.status() === 200, `Broken metadata link: ${url}`);
  }
  results.checks.push(`${metadataLinks.length} script / metadata links`);
  const thirdParty = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => new URL(entry.name).origin !== location.origin).map(entry => entry.name));
  check(thirdParty.length === 0, 'No third-party page resources');
  results.checks.push('no third-party resources');
  await page.evaluate(() => { history.replaceState(null, '', location.pathname + location.search); window.scrollTo(0, 0); });
  return results;
}
