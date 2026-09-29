// Render chosen demo times at 1920x1080: node frames.cjs out/prefix 0,3.5,12.4
const { open } = require('./lab.cjs');
(async () => {
  const out = process.argv[2];
  const times = process.argv[3].split(',').map(Number);
  const { browser, page, logs } = await open({ width: 1920, height: 1080, query: '?demo=1' });
  await page.evaluate(() => __lab.pause(true));
  for (const t of times) {
    await page.evaluate(t => __lab.renderDemoFrame(t), t);
    await page.waitForTimeout(500); // let fonts/textures settle, then render the same time again
    const st = await page.evaluate(t => { const s = __lab.renderDemoFrame(t); delete s.events; return s; }, t);
    await page.screenshot({ path: `${out}-t${String(t).replace('.', '_')}.png` });
    console.log(t, JSON.stringify(st));
  }
  console.log('EVENTS', JSON.stringify(await page.evaluate(() => __lab.renderDemoFrame(1e9).events || [])));
  console.log(logs.join('\n') || 'no console errors');
  await browser.close();
})();
