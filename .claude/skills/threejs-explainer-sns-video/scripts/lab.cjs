// Shared Playwright harness: opens the page with CDN/font requests served locally and collects console errors.
// Env: PAGE_URL (default http://localhost:8765/index.html), THREE_VERSION (default 0.183.2), CHROMIUM (default /opt/pw-browsers/chromium)
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const PAGE_URL = process.env.PAGE_URL || 'http://localhost:8765/index.html';
const THREE_VERSION = process.env.THREE_VERSION || '0.183.2';
const THREE_DIR = path.join(process.cwd(), 'node_modules/three');
const CACHE = path.join(process.cwd(), 'font-cache');
fs.mkdirSync(CACHE, { recursive: true });
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// Google Fonts through curl (Chromium's own requests via a sandbox proxy are unreliable); cached on disk.
function cached(url) {
  const f = path.join(CACHE, crypto.createHash('sha1').update(url).digest('hex'));
  if (!fs.existsSync(f)) execFileSync('curl', ['-sfL', '-m', '60', '-A', UA, '-o', f, url]);
  return f;
}
exports.open = async ({ width = 1440, height = 900, query = '', dpr = 1 } = {}) => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', r => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  await page.route(`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/**`, route => {
    const rel = new URL(route.request().url()).pathname.replace(`/npm/three@${THREE_VERSION}/`, '');
    route.fulfill({ path: path.join(THREE_DIR, rel), contentType: 'application/javascript' });
  });
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, route => {
    const url = route.request().url();
    try {
      const f = cached(url);
      const type = url.includes('googleapis') ? 'text/css' : url.endsWith('.woff2') ? 'font/woff2' : 'font/ttf';
      route.fulfill({ path: f, contentType: type, headers: { 'access-control-allow-origin': '*' } });
    } catch (e) { route.abort(); }
  });
  await page.goto(`${PAGE_URL}${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__lab && window.__lab.ready, null, { timeout: 180000 });
  return { browser, page, logs };
};
