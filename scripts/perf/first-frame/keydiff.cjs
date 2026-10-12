// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

const { chromium } = require('./lib.cjs').playwright();
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await p.addInitScript(() => { const t = setInterval(() => { const v = window.viewer; if (v && !window.__h) { window.__h = 1;
      v.on('model-loaded', () => { window.__k1 = (v.renderer.info.programs || []).map(x => ({ n: x.name, k: x.cacheKey })); }); } }, 5); });
  await p.goto(process.argv[2]);
  await p.waitForFunction(() => window.__k1 && document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout: 120000 });
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => {
    const k2 = (window.viewer.renderer.info.programs || []).map(x => ({ n: x.name, k: x.cacheKey }));
    const s1 = new Set(window.__k1.map(x => x.k));
    const added = k2.filter(x => !s1.has(x.k));
    const out = [];
    for (const a of added) {
      const twin = window.__k1.find(x => x.n === a.n && x.n);
      if (!twin) { out.push({ name: a.n || '(unnamed)', diff: 'kein Zwilling', keyHead: a.k.slice(0, 160) }); continue; }
      const A = a.k.split(','), B = twin.k.split(','); const d = [];
      for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) d.push(i + ':' + B[i] + '→' + A[i]);
      out.push({ name: a.n, diff: d.slice(0, 12).join(' ') });
    }
    return { atModelLoaded: window.__k1.length, final: k2.length, added: out };
  });
  console.log('Programme bei model-loaded:', r.atModelLoaded, ' nach erstem Bild:', r.final, ' neu:', r.added.length);
  const agg = {}; for (const a of r.added) agg[a.diff] = (agg[a.diff] || []).concat(a.name);
  for (const [d, names] of Object.entries(agg)) console.log(names.length + 'x', '[' + d + ']', names.slice(0, 6).join(', '));
  await b.close();
})();
