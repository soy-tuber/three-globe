// Contact sheet for review: node grid.cjs out.png a.png b.png ... (contain-fit, 2 columns)
const sharp = require('sharp');
(async () => {
  const [out, ...files] = process.argv.slice(2);
  const W = 720, H = 450;
  const tiles = await Promise.all(files.map(f => sharp(f).resize(W, H, { fit: 'contain', background: '#000' }).png().toBuffer()));
  await sharp({ create: { width: W * 2, height: H * Math.ceil(files.length / 2), channels: 3, background: '#000' } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % 2) * W, top: Math.floor(i / 2) * H }))).png().toFile(out);
})();
