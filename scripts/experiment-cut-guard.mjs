// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/** Generic forbidden-path/import/marker boundary checker. Split paths are inventory only. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const slash = p => p.replace(/\\/g, '/');
export function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = resolve(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
  }).sort();
}
export function matchesPath(path, pattern) {
  const expression = pattern.split(/(\*\*|\*|\?)/).map(s => s === '**' ? '.*' : s === '*' ? '[^/]*' : s === '?' ? '[^/]' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${expression}$`).test(slash(path));
}
/** Repo-relative target. tools/ scripts run from a folder BESIDE the repo and import
 *  `../realvirtual-WebViewer~/src/...` (see tools/des-rng-vectors/README.md): that names
 *  the repo itself, so the part after the folder name is the real repo path. */
function repoRelative(root, target) {
  const rel = slash(relative(root, target));
  const at = rel.lastIndexOf('realvirtual-WebViewer~/');
  return at === -1 ? rel : rel.slice(at + 'realvirtual-WebViewer~/'.length);
}
export function importEdges(root, dirs = ['src']) {
  const configPath = resolve(root, 'tsconfig.json');
  const options = existsSync(configPath)
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root).options
    : { moduleResolution: ts.ModuleResolutionKind.Bundler, baseUrl: root, paths: { '@rv/*': ['src/*'] } };
  const edges = [];
  for (const file of dirs.flatMap(d => filesUnder(resolve(root, d))).filter(p => /\.[cm]?[jt]sx?$/.test(p))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      let literal;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) literal = node.arguments[0];
      if (literal && ts.isStringLiteralLike(literal)) {
        const spec = literal.text;
        const resolved = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule?.resolvedFileName;
        // Keep deleted relative/alias targets visible: unresolved imports must still fail the cut.
        const fallback = spec.startsWith('.') ? resolve(dirname(file), spec) : spec.startsWith('@rv/') ? resolve(root, 'src', spec.slice(4)) : null;
        const target = resolved ?? fallback;
        if (target) edges.push({ file: slash(relative(root, file)), line: source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1, target: repoRelative(root, target), spec });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return edges;
}
export function isListed(target, entries) {
  return entries.some(e => matchesPath(target, e.path) || (!/\.[a-z]+$/i.test(target) && ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'].some(ext => matchesPath(target + ext, e.path))) || (/\.jsx?$/.test(target) && ['.ts', '.tsx'].some(ext => matchesPath(target.replace(/\.jsx?$/, ext), e.path))));
}
export function checkCut({ publicRoot, privateRoot = resolve(publicRoot, '../realvirtual-WebViewer-Private~'), list = JSON.parse(readFileSync(resolve(publicRoot, 'scripts/commercial-cut-list.json'), 'utf8')) }) {
  const moves = list.paths.filter(e => e.action === 'move');
  const violations = [];
  const publicFiles = [...filesUnder(resolve(publicRoot, 'src')), ...filesUnder(resolve(publicRoot, 'tests')), ...readdirSync(publicRoot).filter(n => n.startsWith('doc-')).flatMap(n => filesUnderOrFile(resolve(publicRoot, n)))];
  for (const file of publicFiles) {
    const path = slash(relative(publicRoot, file));
    if (isListed(path, moves)) violations.push({ check: 'a', file: path, message: 'forbidden public path' });
  }
  // Every path in a transitive hull ends at a direct edge into the move set.
  // Checking every public source module captures those terminal edges, including helpers.
  // tools/ ships with the public repo too: its scripts must not reach a moved path either.
  for (const edge of importEdges(publicRoot, ['src', 'tools'])) {
    if (isListed(edge.target, moves)) violations.push({ check: 'b', ...edge, message: 'import reaches forbidden path' });
  }
  for (const file of filesUnder(resolve(publicRoot, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const marker of list.forbiddenMarkers) {
      let at = text.indexOf(marker);
      while (at !== -1) {
        violations.push({ check: 'c', file: slash(relative(publicRoot, file)), line: text.slice(0, at).split('\n').length, message: `forbidden marker: ${marker}` });
        at = text.indexOf(marker, at + marker.length);
      }
    }
  }
  for (const file of filesUnder(resolve(privateRoot, 'src/plugins/des-experiments'))) {
    if (readFileSync(file, 'utf8').includes('AGPL-3.0')) violations.push({ check: 'd', file: slash(relative(privateRoot, file)), message: 'AGPL-3.0 in private source' });
  }
  return violations;
}
function filesUnderOrFile(path) {
  return readdirSafe(path) ? filesUnder(path) : [path];
}
function readdirSafe(path) { try { readdirSync(path); return true; } catch { return false; } }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const publicRoot = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const violations = checkCut({ publicRoot, ...(process.argv[3] ? { privateRoot: resolve(process.argv[3]) } : {}) });
  for (const v of violations) console.error(`[${v.check}] ${v.file}${v.line ? ':' + v.line : ''}${v.target ? ' -> ' + v.target : ''}: ${v.message}`);
  console.log(`experiment-cut-guard: ${violations.length} violation(s)`);
  process.exitCode = violations.length ? 1 : 0;
}
