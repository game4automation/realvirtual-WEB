// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

const { chromium } = require('./lib.cjs').playwright();
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  const url = process.argv[2] || 'https://web.realvirtual.io/demo/?consent=decline';
  await p.goto(url);
  await p.waitForFunction(() => window.viewer && window.viewer.currentModel && document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout: 120000 }).catch(()=>console.log('timeout'));
  await p.waitForTimeout(3000);
  const r = await p.evaluate(() => {
    const v = window.viewer; const ren = v.renderer; const info = ren.info;
    const progs = (info.programs || []).map(pr => pr.name + ' | ' + (pr.cacheKey || '').length);
    const byName = {}; for (const pr of info.programs || []) byName[pr.name] = (byName[pr.name] || 0) + 1;
    const mats = new Map(); let meshes = 0;
    v.scene.traverse(o => { if (o.isMesh) { meshes++; const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) mats.set(m.uuid, m.type + (m.name ? ':' + m.name.slice(0, 20) : '')); } });
    const mtypes = {}; for (const t of mats.values()) { const k = t.split(':')[0]; mtypes[k] = (mtypes[k] || 0) + 1; }
    return { renderer: ren.constructor.name, programs: (info.programs || []).length, byName, meshes, materials: mats.size, mtypes, drawCalls: info.render.calls, tris: info.render.triangles, textures: info.memory.textures, geometries: info.memory.geometries, shadow: ren.shadowMap?.enabled, dpr: ren.getPixelRatio() };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
