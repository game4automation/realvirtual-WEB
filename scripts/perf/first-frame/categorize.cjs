// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// node categorize.cjs <run.json> — main-thread time buckets in windows: boot(0..glbEnd), post(glbEnd..overlayHidden)
const fs = require('fs'); const base = process.argv[2].replace(/\.json$/, '');
const r = JSON.parse(fs.readFileSync(base + '.json')); const p = JSON.parse(fs.readFileSync(base + '.cpuprofile'));
const glb = r.rs.find(x => /\.glb/.test(x.n)); const glbEnd = glb ? glb.e : 0;
const byId = new Map(p.nodes.map(n => [n.id, n])); const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
// profile time 0 ~ navigation start offset: align using first sample ~ goto; approximate offset = 0 (profile started just before goto)
const cat = (id) => {
  const n = byId.get(id); const f = n.callFrame; const u = f.url;
  if (f.functionName === '(idle)') return 'idle (wartet: Netz/Worker/GPU-async)';
  if (f.functionName === '(garbage collector)') return 'GC';
  if (f.functionName === '(program)') return 'program (Parse/Compile JS, Browser-intern)';
  let c = id, chain = [];
  while (c) { const cf = byId.get(c).callFrame; chain.push(cf.functionName + '|' + cf.url); c = parent.get(c); }
  const s = chain.join(' ');
  if (/fromEquirectangular|_applyPMREM|fromCubemap/.test(s)) return 'PMREM/Envmap';
  if (/getUniforms\||checkShaderErrors|linkProgram|getProgramParameter/.test(s) || (f.functionName === 'R' && /three-/.test(u))) return 'Shader-Compile (sync warten)';
  if (/compileAsync/.test(s)) return 'compileAsync';
  if (/draco|Draco/.test(s)) return 'Draco';
  if (/\.wasm|wasm-function/.test(s)) return 'WASM';
  if (/react-dom|eruda/.test(u)) return 'React/Tools';
  if (/three-/.test(u)) return 'three.js sonstiges (Render/Upload/Parse)';
  if (/index-/.test(u)) return 'App-JS (Entry-Chunk)';
  return 'sonstiges JS: ' + u.replace(/^.*\//, '').slice(0, 30);
};
const win = { boot: {}, post: {}, after: {} }; let t = 0, i = 0;
for (const id of p.samples) { t += p.timeDeltas[i++]; const ms = t / 1000; if (ms > r.overlayHiddenAt) break;
  const w = ms <= glbEnd ? 'boot' : (ms <= r.modelLoadedAt ? 'post' : 'after'); const k = cat(id); win[w][k] = (win[w][k] || 0) + p.timeDeltas[i - 1] / 1000; }
console.log(`== ${r.label}: GLB fertig ${glbEnd} ms, model-loaded ${r.modelLoadedAt}, Bild sichtbar ${r.overlayHiddenAt}`);
for (const w of ['boot', 'post', 'after']) { const tot = Object.values(win[w]).reduce((a, b) => a + b, 0);
  console.log(` [${w}] ${tot.toFixed(0)} ms`);
  for (const [k, v] of Object.entries(win[w]).sort((a, b) => b[1] - a[1])) if (v > 20) console.log('   ' + v.toFixed(0).padStart(6) + ' ms ' + (100 * v / tot).toFixed(0).padStart(3) + '%  ' + k); }
