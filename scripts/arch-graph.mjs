// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * arch-graph.mjs — architecture view of the realvirtual WEB source tree.
 *
 * Parses every .ts/.tsx file of `src/` and (if checked out) the private sibling
 * `../realvirtual-WebViewer-Private~/src/` with the project's own TypeScript
 * compiler, resolves each import through tsconfig.json (so `@rv/*`,
 * `@rv-private/*` and relative paths land on real files) and writes:
 *
 *   .arch/arch-graph.json   file-level graph: modules + import edges (for tools / AI)
 *   .arch/index.html        self-contained viewer: folders as boxes, imports as
 *                           arrows, click a box to open it, click an arrow to see
 *                           the individual imports (ECharts is inlined, works offline)
 *
 * `.arch/` is gitignored: with the private sibling present it describes private code.
 *
 * Usage:
 *   node scripts/arch-graph.mjs                     build .arch/ (npm run arch)
 *   node scripts/arch-graph.mjs --out <dir>         build into another folder
 *   node scripts/arch-graph.mjs --no-private        public tree only
 *   node scripts/arch-graph.mjs --since <git date>  change window for hotspots (default "12 months ago")
 *   node scripts/arch-graph.mjs query deps <file>        what <file> imports
 *   node scripts/arch-graph.mjs query dependents <file>  who imports <file>
 *   node scripts/arch-graph.mjs query folder <prefix>    folder-to-folder edges out of / into <prefix>
 *   node scripts/arch-graph.mjs query cycles [depth]     import cycles between folders (default depth 3)
 *   node scripts/arch-graph.mjs query hotspots [n]       files ranked by lines x commits in the change window
 *
 * Hotspots: every file carries the number of commits that touched it in the change window
 * (`git log` of the public repo and of the private sibling, merges excluded). Large files that
 * change often are where refactoring pays - the viewer can colour by that.
 *
 * File ids are `public/<path below src>` and `private/<path below private src>`.
 * `query` reads the last .arch/arch-graph.json — run the build first.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_SRC = path.resolve(ROOT, '../realvirtual-WebViewer-Private~/src');
const PUBLIC_SRC = path.join(ROOT, 'src');
// typescript + echarts come from the repo's node_modules; RV_ARCH_MODULES points at another
// node_modules folder for a checkout without `npm ci` (the Brain box builds from bare clones).
const MODULES = process.env.RV_ARCH_MODULES ? path.resolve(process.env.RV_ARCH_MODULES) : path.join(ROOT, 'node_modules');
const require = createRequire(path.join(MODULES, '_'));

// ─── CLI ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT_DIR = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : path.join(ROOT, '.arch');
const sinceIdx = argv.indexOf('--since');
const SINCE = sinceIdx >= 0 ? argv[sinceIdx + 1] : '12 months ago';

const queryIdx = argv.indexOf('query');
if (queryIdx >= 0) {
  runQuery(argv.slice(queryIdx + 1));
} else {
  build({ withPrivate: !argv.includes('--no-private') });
}

// ─── Build ────────────────────────────────────────────────────────────────

function build({ withPrivate }) {
  const t0 = Date.now();
  const ts = require('typescript');
  const roots = [{ prefix: 'public', dir: PUBLIC_SRC }];
  if (withPrivate && fs.existsSync(PRIVATE_SRC)) roots.push({ prefix: 'private', dir: PRIVATE_SRC });
  else if (withPrivate) console.warn(`arch-graph: WARNING — private sibling not found (${PRIVATE_SRC}); the view shows the public tree only`);

  const cfgPath = path.join(ROOT, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT, undefined, cfgPath).options;
  const cache = ts.createModuleResolutionCache(ROOT, (s) => s.toLowerCase(), options);

  const files = [];
  for (const r of roots) for (const f of walk(r.dir)) files.push({ abs: f, id: idOf(f, roots) });
  const churn = new Map();
  let churnOk = true;
  for (const r of roots) {
    try {
      for (const [rel, n] of gitChurn(r.dir, SINCE)) churn.set(`${r.prefix}/${rel}`, n);
    } catch (err) {
      churnOk = false;
      console.warn(`arch-graph: no git history for ${r.prefix} (${err.message.split('\n')[0]}) - hotspots stay empty`);
    }
  }
  const byAbs = new Map(files.map((f) => [norm(f.abs), f.id]));

  const modules = [];
  const edges = [];
  const external = new Map();
  let unresolved = 0;

  for (const f of files) {
    const text = fs.readFileSync(f.abs, 'utf8');
    modules.push({ id: f.id, lines: text.split('\n').length, commits: churn.get(f.id) ?? 0 });
    const sf = ts.createSourceFile(f.abs, text, ts.ScriptTarget.Latest, false, f.abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const seen = new Set();
    for (const imp of collectImports(sf, ts)) {
      const spec = imp.spec.replace(/\?.*$/, '');
      const res = ts.resolveModuleName(spec, f.abs, options, ts.sys, cache).resolvedModule;
      const target = res && !res.isExternalLibraryImport ? byAbs.get(norm(res.resolvedFileName)) : undefined;
      if (target) {
        if (target === f.id) continue;
        const key = `${target}|${imp.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: f.id, to: target, kind: imp.kind });
      } else if (res?.isExternalLibraryImport || /^[@a-z]/i.test(spec) && !spec.startsWith('@rv')) {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        external.set(pkg, (external.get(pkg) ?? 0) + 1);
      } else {
        unresolved++;
      }
    }
  }

  const graph = {
    generated: new Date().toISOString(),
    roots: roots.map((r) => r.prefix),
    modules,
    edges,
    external: Object.fromEntries([...external].sort((a, b) => b[1] - a[1])),
    unresolved,
    churn: { since: SINCE, ok: churnOk },
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'arch-graph.json'), JSON.stringify(graph));
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), renderHtml(graph));
  const perRoot = roots.map((r) => `${r.prefix} ${modules.filter((m) => m.id.startsWith(r.prefix + '/')).length}`).join(' + ');
  console.log(`arch-graph: ${modules.length} files (${perRoot}), ${edges.length} imports, ${external.size} packages, ` +
    `${unresolved} unresolved (${Date.now() - t0} ms)\n  → ${path.join(OUT_DIR, 'index.html')}`);
}

/** Commits per file below `dir` since `since`, paths relative to `dir`. */
function gitChurn(dir, since) {
  const out = execFileSync('git', ['log', `--since=${since}`, '--no-merges', '--no-renames', '--relative',
    '--format=', '--name-only', '--', '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const counts = new Map();
  for (const line of out.split('\n')) {
    const f = line.trim();
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function idOf(abs, roots) {
  for (const r of roots) {
    const rel = path.relative(r.dir, abs);
    if (!rel.startsWith('..')) return `${r.prefix}/${rel.split(path.sep).join('/')}`;
  }
  return abs;
}

function norm(p) {
  return path.resolve(p).toLowerCase();
}

/** Static imports/re-exports (kind `static` or `type`) and `import()` calls (kind `dynamic`). */
function collectImports(sf, ts) {
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.importClause?.isTypeOnly ||
        (node.importClause && !node.importClause.name && node.importClause.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.length > 0 &&
          node.importClause.namedBindings.elements.every((e) => e.isTypeOnly));
      out.push({ spec: node.moduleSpecifier.text, kind: typeOnly ? 'type' : 'static' });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ spec: node.moduleSpecifier.text, kind: node.isTypeOnly ? 'type' : 'static' });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
      out.push({ spec: node.arguments[0].text, kind: 'dynamic' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ─── Queries (for humans and AI sessions) ─────────────────────────────────

function loadGraph() {
  const p = path.join(OUT_DIR, 'arch-graph.json');
  if (!fs.existsSync(p)) {
    console.error(`No ${p} — run "npm run arch" first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function matchId(graph, needle) {
  const n = needle.replace(/\\/g, '/').replace(/^(\.\/)?src\//, 'public/');
  const hits = graph.modules.filter((m) => m.id === n || m.id.endsWith('/' + n) || m.id.endsWith(n));
  if (hits.length !== 1) {
    console.error(hits.length ? `Ambiguous "${needle}":\n  ${hits.map((h) => h.id).join('\n  ')}` : `No file matches "${needle}".`);
    process.exit(1);
  }
  return hits[0].id;
}

function groupOf(id, depth) {
  const dirs = id.split('/').slice(0, -1);
  return dirs.slice(0, depth).join('/');
}

function runQuery([cmd, arg]) {
  const g = loadGraph();
  if (cmd === 'deps' || cmd === 'dependents') {
    const id = matchId(g, arg ?? '');
    const list = g.edges.filter((e) => (cmd === 'deps' ? e.from : e.to) === id)
      .map((e) => `${cmd === 'deps' ? e.to : e.from}${e.kind === 'static' ? '' : `  (${e.kind})`}`).sort();
    console.log(`${id} — ${list.length} ${cmd === 'deps' ? 'imports' : 'importers'}`);
    for (const l of list) console.log('  ' + l);
  } else if (cmd === 'folder') {
    const pre = (arg ?? '').replace(/\/$/, '');
    const inside = (id) => id === pre || id.startsWith(pre + '/');
    const tally = (dir) => {
      const m = new Map();
      for (const e of g.edges) {
        const [a, b] = dir === 'out' ? [e.from, e.to] : [e.to, e.from];
        if (inside(a) && !inside(b)) { const k = groupOf(b, 3); m.set(k, (m.get(k) ?? 0) + 1); }
      }
      return [...m].sort((x, y) => y[1] - x[1]);
    };
    console.log(`${pre} → (imports out of the folder)`);
    for (const [k, n] of tally('out')) console.log(`  ${String(n).padStart(4)}  ${k}`);
    console.log(`${pre} ← (imported from outside)`);
    for (const [k, n] of tally('in')) console.log(`  ${String(n).padStart(4)}  ${k}`);
  } else if (cmd === 'cycles') {
    const depth = Number(arg ?? 3);
    const adj = new Map();
    for (const e of g.edges) {
      if (e.kind === 'type') continue;
      const a = groupOf(e.from, depth), b = groupOf(e.to, depth);
      if (a === b) continue;
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a).add(b);
    }
    const sccs = tarjan(adj).filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
    console.log(`${sccs.length} folder cycles at depth ${depth} (type-only imports ignored)`);
    for (const c of sccs) console.log(`  [${c.length}] ${c.sort().join('  ⇄  ')}`);
  } else if (cmd === 'hotspots') {
    const n = Number(arg ?? 25);
    const list = g.modules.filter((m) => m.commits).sort((a, b) => b.commits * b.lines - a.commits * a.lines).slice(0, n);
    console.log(`Top ${list.length} hotspots (lines x commits since ${g.churn?.since ?? '?'})`);
    for (const m of list) console.log(`  ${String(m.commits).padStart(4)} commits  ${String(m.lines).padStart(6)} lines  ${m.id}`);
  } else {
    console.error('query: deps <file> | dependents <file> | folder <prefix> | cycles [depth] | hotspots [n]');
    process.exit(1);
  }
}

function tarjan(adj) {
  let index = 0;
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const nodes = new Set([...adj.keys(), ...[...adj.values()].flatMap((s) => [...s])]);
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = [];
      let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      out.push(c);
    }
  };
  for (const v of nodes) if (!idx.has(v)) strong(v);
  return out;
}

// ─── Viewer ───────────────────────────────────────────────────────────────

function renderHtml(graph) {
  const echarts = fs.readFileSync(require.resolve('echarts/dist/echarts.min.js'), 'utf8');
  const data = JSON.stringify(graph).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>realvirtual WEB Architektur</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--muted:#8b93a7;--accent:#ff538d;--warn:#ff6b6b}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--text);font:13px/1.45 system-ui,Segoe UI,sans-serif}
#app{display:grid;grid-template-columns:minmax(0,1fr) 360px;grid-template-rows:auto 1fr;height:100%}
header{grid-column:1/3;display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
header h1{font-size:14px;margin:0 8px 0 0;font-weight:600}
header label{display:flex;gap:5px;align-items:center;color:var(--muted)}
input,select,button{background:#0f1115;color:var(--text);border:1px solid var(--line);border-radius:5px;padding:4px 7px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--accent)}
#chart{min-height:0}
aside{border-left:1px solid var(--line);background:var(--panel);overflow:auto;padding:12px 14px}
aside h2{font-size:13px;margin:14px 0 6px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
aside h2:first-child{margin-top:0}
.row{display:flex;justify-content:space-between;gap:8px;padding:2px 4px;border-radius:4px;cursor:pointer;word-break:break-all}
.row:hover{background:#222734}.row b{color:var(--muted);font-weight:500;flex:none}
.hint{color:var(--muted)}.cyc{color:var(--warn)}
.legend span{display:inline-flex;align-items:center;gap:5px;margin-right:10px}.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
</style></head><body><div id="app">
<header>
  <h1>realvirtual WEB · Architektur</h1>
  <label>Tiefe <select id="depth"><option selected>2</option><option>3</option><option>4</option><option>5</option></select></label>
  <label>Farbe <select id="color"><option value="area" selected>Bereich</option><option value="hot">Hotspots</option><option value="churn">Änderungen</option></select></label>
  <label>Layout <select id="layout"><option value="layer" selected>Schichten</option><option value="force">Kraft</option></select></label>
  <label><input type="checkbox" id="types"> Typ-Imports</label>
  <label><input type="checkbox" id="dyn" checked> dynamische Imports</label>
  <label><input type="checkbox" id="stubs"> private-stubs</label>
  <label>Mind. Kanten <input type="number" id="min" value="1" min="1" style="width:56px"></label>
  <input id="search" autocomplete="off" placeholder="Ordner/Datei suchen…" style="width:200px">
  <button id="reset">Alles zuklappen</button>
  <span class="legend hint" id="legend"></span>
</header>
<div id="chart"></div>
<aside id="side"></aside>
</div>
<script>${echarts}</script>
<script>
const G = ${data};
const $ = (id) => document.getElementById(id);
const chart = echarts.init($('chart'), 'dark', { renderer: 'canvas' });
const lines = new Map(G.modules.map(m => [m.id, m.lines]));
const expanded = new Set();
let selected = null;

const PALETTE = { 'public/core': '#4ea1ff', 'public/plugins': '#2ec4a6', 'public/hooks': '#9b8cff', 'public/behaviors': '#f2b84b',
  private: '#ff538d', public: '#8b93a7' };
function colorOf(g) {
  for (const k of ['public/core', 'public/plugins', 'public/hooks', 'public/behaviors', 'private', 'public']) if (g === k || g.startsWith(k + '/')) return PALETTE[k];
  return '#8b93a7';
}
const AREA_LEGEND = Object.entries({ 'core': PALETTE['public/core'], 'plugins': PALETTE['public/plugins'], 'hooks': PALETTE['public/hooks'],
  'behaviors': PALETTE['public/behaviors'], 'private': PALETTE.private, 'sonst. public': PALETTE.public })
  .map(([k, c]) => '<span><i style="background:' + c + '"></i>' + k + '</span>').join('');
const BACK_LEGEND = '<span><i style="background:#ff6b6b"></i>Import gegen den Fluss (schließt Zyklus)</span>';
const HEAT_LEGEND = '<span><i style="background:linear-gradient(90deg,#2b3140,#f2b84b,#ff4d4d);width:60px"></i>';

/** Sequential heat ramp for t in 0..1: slate, amber, red. */
function heat(t) {
  const stops = [[0x2b, 0x31, 0x40], [0xf2, 0xb8, 0x4b], [0xff, 0x4d, 0x4d]];
  const x = Math.max(0, Math.min(1, t)) * 2, i = Math.min(1, Math.floor(x)), f = x - i;
  return 'rgb(' + stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f)).join(',') + ')';
}
function legend() {
  const mode = $('color').value;
  const what = mode === 'hot' ? 'Zeilen × Änderungen' : 'Änderungen';
  $('legend').innerHTML = (mode === 'area' ? AREA_LEGEND : HEAT_LEGEND + what + ' seit ' + G.churn.since + ': wenig → viel</span>') + BACK_LEGEND;
}

function groupOf(id) {
  const segs = id.split('/'), dirs = segs.slice(0, -1);
  let d = Math.min(+$('depth').value, dirs.length);
  while (d < dirs.length && expanded.has(dirs.slice(0, d).join('/'))) d++;
  if (d === dirs.length && expanded.has(dirs.join('/'))) return id;
  return dirs.slice(0, d).join('/');
}

function aggregate() {
  const showTypes = $('types').checked, showDyn = $('dyn').checked, stubs = $('stubs').checked;
  const keep = (id) => stubs || !id.startsWith('public/private-stubs');
  const nodes = new Map(), edges = new Map();
  for (const m of G.modules) {
    if (!keep(m.id)) continue;
    const g = groupOf(m.id);
    const n = nodes.get(g) ?? { id: g, files: 0, lines: 0, commits: 0, hot: 0 };
    n.files++; n.lines += m.lines; n.commits += m.commits; n.hot += m.commits * m.lines; nodes.set(g, n);
  }
  for (const e of G.edges) {
    if (!keep(e.from) || !keep(e.to)) continue;
    if (e.kind === 'type' && !showTypes) continue;
    if (e.kind === 'dynamic' && !showDyn) continue;
    const a = groupOf(e.from), b = groupOf(e.to);
    if (a === b) continue;
    const k = a + '\\u0000' + b;
    const x = edges.get(k) ?? { from: a, to: b, n: 0, list: [] };
    x.n++; x.list.push(e); edges.set(k, x);
  }
  const min = Math.max(1, +$('min').value || 1);
  return { nodes, edges: [...edges.values()].filter(e => e.n >= min) };
}

function sccs(nodes, edges) {
  const adj = new Map([...nodes.keys()].map(k => [k, []]));
  for (const e of edges) adj.get(e.from)?.push(e.to);
  let i = 0; const idx = new Map(), low = new Map(), on = new Set(), st = [], comp = new Map(); let c = 0;
  const strong = (v) => {
    idx.set(v, i); low.set(v, i); i++; st.push(v); on.add(v);
    for (const w of adj.get(v)) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) { let w; do { w = st.pop(); on.delete(w); comp.set(w, c); } while (w !== v); c++; }
  };
  for (const v of adj.keys()) if (!idx.has(v)) strong(v);
  return comp;
}

/**
 * Greedy feedback-arc ordering: folders that mostly import go first, folders that are mostly
 * imported go last. An import that points backwards in that order is a "back edge" — it is what
 * closes a cycle, it is drawn red and the layering ignores it. Layer = longest chain of forward
 * imports below a node, so imported code sits right.
 */
function layout(nodes, edges) {
  const ids = [...nodes.keys()];
  const w = new Map(ids.map(id => [id, { out: 0, in: 0 }]));
  for (const e of edges) { w.get(e.from).out += e.n; w.get(e.to).in += e.n; }
  const live = new Set(ids), order = [];
  const outLive = (id) => edges.reduce((s, e) => s + (e.from === id && live.has(e.to) ? e.n : 0), 0);
  const inLive = (id) => edges.reduce((s, e) => s + (e.to === id && live.has(e.from) ? e.n : 0), 0);
  const head = [], tail = [];
  while (live.size) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const id of [...live]) {
        if (inLive(id) === 0) { head.push(id); live.delete(id); moved = true; }
        else if (outLive(id) === 0) { tail.unshift(id); live.delete(id); moved = true; }
      }
    }
    if (!live.size) break;
    let best = null, bestScore = -Infinity;
    for (const id of live) { const sc = outLive(id) - inLive(id); if (sc > bestScore) { bestScore = sc; best = id; } }
    head.push(best); live.delete(best);
  }
  order.push(...head, ...tail);
  const rank = new Map(order.map((id, i) => [id, i]));
  const back = new Set(edges.filter(e => rank.get(e.from) > rank.get(e.to)));
  const depth = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let d = 0;
    for (const e of edges) if (e.from === id && !back.has(e)) d = Math.max(d, depth.get(e.to) + 1);
    depth.set(id, d);
  }
  const maxD = Math.max(0, ...depth.values());
  const cols = new Map();
  for (const id of ids) { const x = maxD - depth.get(id); if (!cols.has(x)) cols.set(x, []); cols.get(x).push(id); }
  const pos = new Map();
  const nb = new Map(ids.map(k => [k, []]));
  for (const e of edges) { nb.get(e.from).push(e.to); nb.get(e.to).push(e.from); }
  for (const [x, col] of cols) { col.sort(); col.forEach((id, i) => pos.set(id, { x, y: i - (col.length - 1) / 2 })); }
  for (let pass = 0; pass < 8; pass++) {
    for (const [, col] of cols) {
      const bary = (id) => { const n = nb.get(id); return n.length ? n.reduce((s, o) => s + pos.get(o).y, 0) / n.length : pos.get(id).y; };
      const b = new Map(col.map(id => [id, bary(id)]));
      col.sort((a, c) => b.get(a) - b.get(c));
      col.forEach((id, i) => pos.get(id).y = i - (col.length - 1) / 2);
    }
  }
  // Rank → pixels: each column is as wide as its widest box, rows are 40 px apart.
  let x = 0;
  for (const c of [...cols.keys()].sort((a, b) => a - b)) {
    const col = cols.get(c);
    const w = Math.max(...col.map(id => boxWidth(id)));
    for (const id of col) { const p = pos.get(id); p.x = x + w / 2; p.y *= 40; }
    x += w + 70;
  }
  return { pos, back };
}

function boxWidth(id) {
  return lines.has(id) ? 24 : Math.max(60, label(id).length * 6.6 + 18);
}

/** ECharts fits the pixel layout into the chart; proportions (and so the spacing) are kept. */
function fitBox(pos, layered) {
  return layered ? { left: 30, right: 150, top: 30, bottom: 30, nodeScaleRatio: 0.6 } : { nodeScaleRatio: 0.6 };
}

function label(id) {
  if (lines.has(id)) return id.split('/').pop();
  const s = id.split('/');
  return s.length === 1 ? id + ' (root)' : s.length > 2 ? s.slice(1).join('/') : id;
}

function render() {
  const { nodes, edges } = aggregate();
  const comp = sccs(nodes, edges);
  const compSize = new Map();
  for (const c of comp.values()) compSize.set(c, (compSize.get(c) ?? 0) + 1);
  const inCycle = (id) => compSize.get(comp.get(id)) > 1;
  const { pos, back } = layout(nodes, edges);
  const layered = $('layout').value === 'layer';
  const q = $('search').value.trim().toLowerCase();
  const maxLines = Math.max(...[...nodes.values()].map(n => n.lines));
  const mode = $('color').value;
  const metric = (n) => mode === 'hot' ? n.hot : n.commits;
  const maxMetric = Math.max(1, ...[...nodes.values()].map(metric));
  legend();
  const focus = selected && nodes.has(selected) ? new Set([selected, ...edges.filter(e => e.from === selected || e.to === selected).flatMap(e => [e.from, e.to])]) : null;

  const data = [...nodes.values()].map(n => {
    const dim = (q && !n.id.toLowerCase().includes(q)) || (focus && !focus.has(n.id));
    const isFile = lines.has(n.id);
    // sqrt spreads the long tail: a few huge hotspots would otherwise leave everything else grey.
    const t = mode === 'area' ? null : Math.sqrt(metric(n) / maxMetric);
    const fill = t === null ? colorOf(n.id) : heat(t);
    const darkText = t === null || t > 0.3;
    return {
      id: n.id, name: label(n.id), value: n.files,
      x: layered ? pos.get(n.id).x : undefined, y: layered ? pos.get(n.id).y : undefined,
      symbol: isFile ? 'circle' : 'roundRect',
      symbolSize: isFile ? 10 + 20 * Math.sqrt(n.lines / maxLines) : [boxWidth(n.id), 16 + 18 * Math.sqrt(n.lines / maxLines)],
      itemStyle: { color: fill, opacity: dim ? 0.15 : 1, borderColor: inCycle(n.id) ? '#ff6b6b' : n.id === selected ? '#fff' : 'transparent', borderWidth: 2 },
      label: { show: true, position: isFile ? 'right' : 'inside', color: dim ? '#555' : (isFile || !darkText ? '#e6e8ee' : '#0f1115'), fontSize: 11, fontWeight: 600 },
      tooltip: { formatter: n.id + '<br>' + n.files + ' Dateien · ' + n.lines.toLocaleString('de') + ' Zeilen · ' + n.commits + ' Änderungen' + (isFile ? '' : '<br><i>Klick: Details · Doppelklick: öffnen</i>') },
    };
  });
  const maxN = Math.max(1, ...edges.map(e => e.n));
  const links = edges.map(e => {
    const cyc = back.has(e);
    const dim = focus && !(e.from === selected || e.to === selected);
    return {
      source: e.from, target: e.to, value: e.n, _e: e,
      lineStyle: { width: 0.6 + 5 * Math.sqrt(e.n / maxN), color: cyc ? '#ff6b6b' : '#7a8296', opacity: dim ? 0.04 : (focus ? 0.8 : 0.35), curveness: 0.15 },
      tooltip: { formatter: e.from + ' → ' + e.to + '<br>' + e.n + ' Imports' },
    };
  });
  chart.setOption({
    backgroundColor: '#0f1115', tooltip: { confine: true }, animationDurationUpdate: 300,
    series: [{
      type: 'graph', layout: layered ? 'none' : 'force', roam: true, draggable: true, data, links,
      ...fitBox(pos, layered),
      edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 7,
      force: { repulsion: 900, edgeLength: [120, 320], gravity: 0.05 },
      emphasis: { focus: 'adjacency', lineStyle: { opacity: 0.9 } },
    }],
  }, true);
  // ECharts 6 sizes graph symbols wrongly on a notMerge render with layout 'none' (boxes come
  // out invisible); a second, merging setOption recomputes them.
  chart.setOption({ series: [{ nodeScaleRatio: 0.6 }] });
  side(nodes, edges, comp, compSize, back);
}

function rowsHtml(list) {
  return list.map(([k, n, attr]) => '<div class="row" ' + attr + '><span>' + k + '</span><b>' + n + '</b></div>').join('') || '<div class="hint">—</div>';
}

function side(nodes, edges, comp, compSize, back) {
  const backList = [...back].sort((a, b) => b.n - a.n);
  const s = $('side');
  if (selected && nodes.has(selected)) {
    const n = nodes.get(selected);
    const out = edges.filter(e => e.from === selected).sort((a, b) => b.n - a.n);
    const inn = edges.filter(e => e.to === selected).sort((a, b) => b.n - a.n);
    const canOpen = !lines.has(selected);
    s.innerHTML = '<h2>Auswahl</h2><div style="word-break:break-all"><b>' + selected + '</b></div>' +
      '<div class="hint">' + n.files + ' Dateien · ' + n.lines.toLocaleString('de') + ' Zeilen · ' + n.commits + ' Änderungen seit ' + G.churn.since + (compSize.get(comp.get(selected)) > 1 ? ' · <span class="cyc">in einem Zyklus</span>' : '') + '</div>' +
      (canOpen ? '<p><button onclick="openGroup(selected)">Ordner öffnen</button></p>' : '') +
      (expandedParent(selected) ? '<p><button onclick="closeGroup(selected)">Übergeordneten Ordner schließen</button></p>' : '') +
      '<h2>importiert (' + out.reduce((a, e) => a + e.n, 0) + ')</h2>' + rowsHtml(out.map(e => [e.to, e.n, 'onclick="showEdge(\\'' + e.from + '\\',\\'' + e.to + '\\')"'])) +
      '<h2>wird importiert von (' + inn.reduce((a, e) => a + e.n, 0) + ')</h2>' + rowsHtml(inn.map(e => [e.from, e.n, 'onclick="showEdge(\\'' + e.from + '\\',\\'' + e.to + '\\')"'])) +
      '<div id="edgeList"></div>';
  } else {
    const cycles = new Map();
    for (const [id, c] of comp) if (compSize.get(c) > 1) { if (!cycles.has(c)) cycles.set(c, []); cycles.get(c).push(id); }
    s.innerHTML = '<h2>Überblick</h2><div class="hint">' + G.modules.length + ' Dateien · ' + G.edges.length + ' Imports · Stand ' + new Date(G.generated).toLocaleString('de') + '</div>' +
      '<p class="hint">Pfeil = „importiert“. Rechts steht Basiscode, der viel benutzt wird, links Code, der viel benutzt. Klick wählt aus, Doppelklick öffnet einen Ordner, Mausrad zoomt.</p>' +
      '<h2 class="cyc">Rote Imports (' + backList.length + ')</h2><p class="hint">Diese Imports laufen gegen den Fluss. Ohne sie wäre der Graph zyklenfrei.</p>' +
      rowsHtml(backList.slice(0, 25).map(e => [e.from + ' → ' + e.to, e.n, 'onclick="select(\\'' + e.from + '\\')"'])) +
      '<h2 class="cyc">Zyklen (' + cycles.size + ')</h2>' + ([...cycles.values()].map(c => '<div class="row" style="cursor:default">' + c.sort().join(' ⇄ ') + '</div>').join('') || '<div class="hint">keine</div>') +
      '<h2>Hotspots (Dateien)</h2><p class="hint">Groß und oft geändert (Zeilen × Commits seit ' + G.churn.since + '). Klick sucht die Datei.</p>' +
      (G.churn.ok ? rowsHtml(G.modules.filter(m => m.commits).sort((a, b) => b.commits * b.lines - a.commits * a.lines).slice(0, 20)
        .map(m => [m.id, m.commits + '× · ' + m.lines.toLocaleString('de'), 'onclick="findFile(\\'' + m.id + '\\')"'])) : '<div class="hint">keine git-Historie gefunden</div>') +
      '<h2>Größte Bereiche</h2>' + rowsHtml([...nodes.values()].sort((a, b) => b.lines - a.lines).slice(0, 15).map(n => [n.id, n.lines.toLocaleString('de'), 'onclick="select(\\'' + n.id + '\\')"'])) +
      '<h2>Externe Pakete</h2>' + rowsHtml(Object.entries(G.external).slice(0, 15).map(([k, n]) => [k, n, ''])) +
      (G.unresolved ? '<p class="hint">' + G.unresolved + ' Imports ließen sich nicht auflösen.</p>' : '');
  }
}

function expandedParent(id) {
  const dirs = id.split('/'); for (let d = dirs.length - 1; d > 0; d--) if (expanded.has(dirs.slice(0, d).join('/'))) return dirs.slice(0, d).join('/');
  return null;
}
window.select = (id) => { selected = id; render(); };
window.findFile = (id) => { $('search').value = id.split('/').pop(); selected = null; render(); };
window.openGroup = (id) => { expanded.add(id); selected = null; render(); };
window.closeGroup = (id) => { const p = expandedParent(id); for (const k of [...expanded]) if (k === p || k.startsWith(p + '/')) expanded.delete(k); selected = p; render(); };
window.showEdge = (a, b) => {
  const { edges } = aggregate(); const e = edges.find(x => x.from === a && x.to === b); if (!e) return;
  $('edgeList').innerHTML = '<h2>' + a + ' → ' + b + '</h2>' + e.list.map(x => '<div class="row" style="cursor:default"><span>' + x.from.split('/').pop() + ' → ' + x.to.split('/').pop() + '</span><b>' + (x.kind === 'static' ? '' : x.kind) + '</b></div>').join('');
};

chart.on('click', (p) => {
  if (p.dataType === 'node') { selected = selected === p.data.id ? null : p.data.id; render(); }
  else if (p.dataType === 'edge') { selected = p.data._e.from; render(); window.showEdge(p.data._e.from, p.data._e.to); }
});
chart.on('dblclick', (p) => { if (p.dataType === 'node' && !lines.has(p.data.id)) window.openGroup(p.data.id); });
chart.getZr().on('click', (e) => { if (!e.target && selected) { selected = null; render(); } });
for (const id of ['color', 'depth', 'layout', 'types', 'dyn', 'stubs', 'min']) $(id).addEventListener('change', render);
$('search').addEventListener('input', render);
$('reset').addEventListener('click', () => { expanded.clear(); selected = null; render(); });
addEventListener('resize', () => chart.resize());
render();
</script></body></html>
`;
}
