// Frame-exact video export: node export.cjs out.mp4 [seconds=30] [fps=30]
// Frames are piped as JPEG into ffmpeg, so no frame files hit the disk.
const { open } = require('./lab.cjs');
const { spawn } = require('child_process');
const FF = process.env.FFMPEG || require('@ffmpeg-installer/ffmpeg').path;
(async () => {
  const [out, secs = '30', fps = '30'] = process.argv.slice(2);
  const N = Math.round(+secs * +fps);
  const { browser, page, logs } = await open({ width: 1920, height: 1080, query: '?demo=1' });
  await page.evaluate(() => __lab.pause(true));
  await page.evaluate(() => __lab.renderDemoFrame(0));
  await page.waitForTimeout(1500); // warm up shaders and fonts
  const ff = spawn(FF, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', fps, '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', fps, out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await page.evaluate(t => { __lab.renderDemoFrame(t); }, i / +fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 60 === 0) console.log(`frame ${i}/${N} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('EVENTS', JSON.stringify(await page.evaluate(() => __lab.renderDemoFrame(1e9).events || [])));
  console.log(logs.join('\n') || 'no console errors');
  await browser.close();
})();
