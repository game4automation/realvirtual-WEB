// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Three static guards over the dev-only seams. No browser, no build, no viewer:
 * all of them read source with the TypeScript parser, so they are cheap enough
 * to run on every change and precise enough to name a file and a line.
 *
 * They exist because of one failure class, found in the public demo on
 * 2026-10-25: the Settings tab "Tests" was visible in EVERY desktop build, its
 * "Run Tests" button POSTed the dev-server route `/__api/tests/run`, the static
 * host answered `index.html` with HTTP 200, and the visitor was shown the JSON
 * parser's `Unexpected token '<'`. A surface that looks usable and is not. The
 * two halves of that bug get one guard each:
 *
 *  (a) DEV-only GLOBALS - a `window.__rv*` handle installed inside `main.ts`'
 *      `if (import.meta.env.DEV)` block does not exist in a build, so no module
 *      may READ one and treat it as available.
 *
 *  (b) DEV-only ROUTES - a dev-server URL prefix may only be reached from a
 *      branch the build drops, or from a module that owns the absence of the
 *      route and is listed here with its reason.
 *
 * Guard (a) derives its name list from `main.ts` instead of pinning it. That is
 * the point: a DEV global added tomorrow is covered the day it is written, with
 * nobody having to remember this file.
 *
 * Guard (c) was added on 2026-10-25 for the SECOND public-demo defect of that
 * day, which the two above do not see because nothing about it is dev-only any
 * more:
 *
 *  (c) THE VIEWER GLOBALS - no module under `src/` may READ `window.viewer` or
 *      `window.__rvViewer`. Product code gets the viewer from the plugin
 *      context that hands it over; a global is a seam whose absence nobody
 *      notices.
 *
 * There used to be two viewer globals with two different gates: `window.viewer`
 * ungated, `window.__rvViewer` inside `main.ts`' `if (import.meta.env.DEV)` -
 * i.e. the official-sounding name was the one that silently did not exist in a
 * build. The MuJoCo walker's `syncObstacleVisuals()` reached the scene through
 * `__rvViewer`, got `undefined` in production, and pushed obstacles whose drawn
 * meshes never moved: 34 obstacles, 5 contact pairs, `obstacleVisualCount` 0,
 * `obs_cube_s1` shoved 75.6 mm with the cube on screen unmoved, in the public
 * demo, without a warning. `main.ts` now publishes `__rvViewer` as a plain
 * alias of `window.viewer` in EVERY build, so the trap is gone - and this guard
 * keeps the lesson: the fix is that product code binds through its owner, not
 * that the global works.
 *
 * Guard (c) works on the AST, never on text. That is deliberate: the banned
 * names occur in prose all over this tree (this comment block alone names both
 * of them several times), and a negative assertion that can see a comment is an
 * assertion that fires on the sentence explaining the defect. A property-access
 * node carries no comment, so there is nothing to strip; `the detector reads
 * code, not prose` below proves it on a fixture that hides the forbidden read
 * in a comment and in a string.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(root, '..', 'realvirtual-WebViewer-Private~');

// -- Allow-lists -------------------------------------------------------------
// Every entry carries a REASON, and the reason is checked to exist. An entry
// without one is not an exemption, it is an unexplained hole; the guards fail
// on it. Keep both lists shrinking: a new entry wants an argument, not a line.

/** Modules permitted to READ a DEV-only global (guard a). */
const GLOBAL_READERS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/plugins/demo/perf-test-plugin.ts',
    reason:
      'The perf harness plugin reaches the harness hooks through globalThis BY DESIGN (main.ts '
      + 'installs them, the plugin never imports them, so production carries 0 KB of harness). '
      + 'It refuses loudly and by name when a hook is missing instead of reporting a green run.',
  },
  // The MuJoCo locomotion runtime used to be listed here for `window.__rvViewer`.
  // That global is no longer DEV-only (main.ts publishes it as an alias in every
  // build), so guard (a) does not collect the name any more and the entry would
  // be a dead exemption. It moved to VIEWER_GLOBAL_READERS below, where the rule
  // that now covers it lives.
];

/** The viewer globals `main.ts` installs. Both ungated since 2026-10-25. */
const VIEWER_GLOBALS: ReadonlySet<string> = new Set(['viewer', '__rvViewer']);

/**
 * Modules permitted to READ a viewer global (guard c).
 *
 * `src/main.ts` is not listed and must not be: it ASSIGNS both names, and an
 * assignment target is not a read. Nothing else in the public tree reads them
 * today - the viewer arrives through the plugin/UI-slot context. A debug overlay
 * that genuinely has no context to take it from belongs here WITH its argument;
 * a module that simply finds the global convenient does not.
 */
const VIEWER_GLOBAL_READERS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    // PRIVATE tree (`realvirtual-WebViewer-Private~/src/mujoco/...`).
    file: 'src/mujoco/rv-mujoco-locomotion-runtime.ts',
    reason:
      'A bounded fallback BEHIND the owner path, and the owner path is the fix: the locomotion '
      + 'plugin hands the runtime the scene of the viewer it owns, and only a caller with a '
      + 'runtime and no plugin - the headless spikes in spikes/659 - falls through to the '
      + 'optional-chained `window.__rvViewer?.scene`, at most `visualProbes` times. Note for '
      + 'whoever reads that code next: its comment still calls the global DEV-ONLY, which stopped '
      + 'being true on 2026-10-25 - the probe now also resolves in a build, so it can mask a '
      + 'missing `attachObstacleVisuals()` call instead of failing loudly. That is why the first '
      + 'assertion of tests/mujoco-obstacle-visuals.node.test.ts (the plugin binds from '
      + '`this.viewer.scene`) is the one that matters, not this fallback.',
  },
];

/** Dev-server URL prefixes that must not be reachable from a delivered build (guard b). */
const DEV_ROUTE_PREFIXES = [
  '/__api/',
  '/unity-api',
  '/api/preset',
  '/node_modules/',
] as const;

/** Modules permitted to name a dev-server route outside a DEV branch (guard b). */
const ROUTE_OWNERS: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/core/rv-dev-api.ts',
    reason:
      'THE owner of the dev test API routes and the one module that may name them unguarded: its '
      + 'whole job is to ask whether this origin serves them and to report absence as a normal '
      + 'state. A DEV gate here would be the very bug the module removes - a build served from '
      + "CONNECT's dev-proxy origin can reach the route legitimately (plan-383).",
  },
  {
    file: 'src/core/hmi/DevToolbarPopover.tsx',
    reason:
      'The dev toolbar family renders only behind `RV_SERVE_INFO !== null`, which vite.config '
      + 'substitutes with the literal `null` in every build. Stronger than a DEV branch and '
      + 'already proven: tests/dev-toolbar-bundle-absence.node.test.ts asserts the bundle carries '
      + 'none of it.',
  },
  {
    file: 'src/plugins/debug-endpoint-plugin.ts',
    reason:
      "The module is reached ONLY by the dynamic import inside main.ts' DEV branch, so a "
      + 'production build drops the branch, the import and the chunk together. The companion case '
      + 'below asserts that this is still the only importer.',
  },
  {
    // PRIVATE tree. Flagged by this guard on the day it was written (2026-10-25,
    // src/plugins/layout-cloud/unity-cloud-adapter.ts:55) and REPORTED rather than
    // quietly exempted. Listed, not fixed, because a fix for exactly this line is
    // in flight in the canonical checkout.
    file: 'src/plugins/layout-cloud/unity-cloud-adapter.ts',
    reason:
      '`/unity-api` is the LAST fallback of a configurable base - `window.__RV_UNITY_API_BASE__` '
      + 'overrides it, and the Unity Cloud layout library is an internal-tier surface no delivered '
      + 'build offers. The in-flight canonical change makes the fallback warn instead of silently '
      + 'addressing a dev proxy; this entry goes away with it.',
  },
];

// -- Source walking ----------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

interface Source {
  /** Repo-relative, forward-slashed, e.g. `src/core/hmi/SettingsPanel.tsx`. */
  id: string;
  file: ts.SourceFile;
}

function parseText(id: string, text: string): Source {
  return {
    id,
    file: ts.createSourceFile(
      id, text, ts.ScriptTarget.Latest, true,
      id.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
}

function parse(absolute: string, base: string): Source {
  const text = readFileSync(absolute, 'utf8');
  const id = relative(base, absolute).split('\\').join('/');
  return parseText(id, text);
}

function lineOf(src: Source, node: ts.Node): number {
  return src.file.getLineAndCharacterOfPosition(node.getStart(src.file)).line + 1;
}

/** Every `.ts`/`.tsx` under `src/` of both trees. Ids are relative to their own tree. */
function allSources(): Source[] {
  const out = walk(join(root, 'src')).map((p) => parse(p, root));
  for (const p of walk(join(privateRoot, 'src'))) out.push(parse(p, privateRoot));
  return out;
}

/**
 * Parsed ONCE, at module load, and shared by every case below.
 *
 * Not an optimisation: parsing both trees takes ~4.5 s, and each case that
 * called `allSources()` paid it again inside vitest' 5 s `testTimeout`. Guard
 * (a)'s reader case was already timing out on a loaded machine before guard (c)
 * was added - a guard that goes red because the machine was busy teaches the
 * next reader to ignore it. Module scope is outside the per-test timeout.
 */
const SOURCES: readonly Source[] = allSources();

// -- DEV-branch detection ----------------------------------------------------

const DEV_FLAG = /import\s*\.\s*meta\s*\.\s*env\s*\.\s*DEV/;
const BUILD_MODE_FLAG = /import\s*\.\s*meta\s*\.\s*env\s*\.\s*(DEV|PROD)/;

/**
 * Is `node` inside a branch that only runs on a dev server?
 *
 * Walks the parent chain and accepts the then-branch of `if (...DEV...)`, the
 * right-hand side of `...DEV && x`, the true-arm of `...DEV ? x : y` and the
 * false-arm of `...PROD ? x : y`. The negated forms are deliberately NOT
 * accepted: a route reached when the build mode says production is exactly what
 * these guards are here to catch.
 */
function insideDevBranch(node: ts.Node, file: ts.SourceFile): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && BUILD_MODE_FLAG.test(parent.expression.getText(file))) {
      const positive = DEV_FLAG.test(parent.expression.getText(file));
      if (positive && child === parent.thenStatement) return true;
      if (!positive && child === parent.elseStatement) return true;
    }
    if (
      ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && child === parent.right
      && DEV_FLAG.test(parent.left.getText(file))
    ) return true;
    if (ts.isConditionalExpression(parent) && BUILD_MODE_FLAG.test(parent.condition.getText(file))) {
      const dev = DEV_FLAG.test(parent.condition.getText(file));
      if (child === (dev ? parent.whenTrue : parent.whenFalse)) return true;
    }
  }
  return false;
}

// -- Guard (a): the DEV-only global names, collected from main.ts ------------

/** `(window as ...).NAME = ...` / `(globalThis as ...).NAME = ...` -> NAME, assignments only. */
function assignedGlobalNames(src: Source): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && /\b(window|globalThis)\b/.test(node.left.expression.getText(src.file))
    ) {
      names.add(node.left.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(src.file);
  return names;
}

/**
 * The globals `main.ts` installs inside its `if (import.meta.env.DEV)` blocks,
 * plus the `__rv*` globals installed by the relative modules those blocks
 * dynamically import. That second half is how `__rvSyntheticLine` and
 * `__rvMuComputeBench` get in, without this file knowing any installer by name.
 */
function devOnlyGlobals(): { names: Set<string>; owners: Map<string, string> } {
  const main = parse(join(root, 'src', 'main.ts'), root);
  const names = new Set<string>();
  const owners = new Map<string, string>();
  const specifiers = new Set<string>();

  const visit = (node: ts.Node) => {
    if (insideDevBranch(node, main.file)) {
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)
        && /\b(window|globalThis)\b/.test(node.left.expression.getText(main.file))
      ) {
        names.add(node.left.name.text);
        owners.set(node.left.name.text, 'src/main.ts');
      }
      if (
        ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length >= 1
        && ts.isStringLiteralLike(node.arguments[0])
        && node.arguments[0].text.startsWith('.')
      ) {
        specifiers.add(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(main.file);

  for (const spec of specifiers) {
    const base = resolve(root, 'src', spec);
    const file = ['.ts', '.tsx', '/index.ts', '/index.tsx']
      .map((ext) => `${base}${ext}`)
      .find((p) => existsSync(p));
    if (!file) continue;
    const mod = parse(file, root);
    for (const name of assignedGlobalNames(mod)) {
      if (!name.startsWith('__rv')) continue;
      names.add(name);
      if (!owners.has(name)) owners.set(name, mod.id);
    }
  }
  return { names, owners };
}

/** Property READS of a collected name on any object - assignment targets excluded. */
function globalReads(src: Source, names: Set<string>): Array<{ name: string; line: number }> {
  const hits: Array<{ name: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && names.has(node.name.text)) {
      const isWriteTarget = ts.isBinaryExpression(node.parent)
        && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.parent.left === node;
      if (!isWriteTarget) hits.push({ name: node.name.text, line: lineOf(src, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(src.file);
  return hits;
}

// -- Guard (c): reads of the viewer globals ---------------------------------

/** Strips the wrappers a cast puts between `window` and the property access. */
function unwrapReceiver(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr;
  for (;;) {
    // One kind per line, so each guard narrows `e` and `.expression` is typed -
    // a single combined condition would need a cast, and a cast here could hide
    // a node shape this function does not actually handle.
    if (ts.isParenthesizedExpression(e)) { e = e.expression; continue; }
    if (ts.isAsExpression(e)) { e = e.expression; continue; }
    if (ts.isSatisfiesExpression(e)) { e = e.expression; continue; }
    if (ts.isNonNullExpression(e)) { e = e.expression; continue; }
    if (ts.isTypeAssertionExpression(e)) { e = e.expression; continue; }
    return e;
  }
}

/**
 * Reads of `window.viewer` / `window.__rvViewer` (and their `window['viewer']`
 * and `(window as X).viewer` spellings), assignment targets excluded.
 *
 * The RECEIVER is part of the rule, which is what keeps the guard usable: the
 * tree is full of honest `props.viewer`, `ctx.viewer` and `UISlotProps['viewer']`
 * - the viewer arriving the right way. Only `window`/`globalThis` is flagged.
 */
function viewerGlobalReads(src: Source): Array<{ name: string; line: number }> {
  const hits: Array<{ name: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    let name: string | undefined;
    let receiver: ts.Expression | undefined;
    if (ts.isPropertyAccessExpression(node) && VIEWER_GLOBALS.has(node.name.text)) {
      name = node.name.text;
      receiver = node.expression;
    } else if (
      ts.isElementAccessExpression(node)
      && node.argumentExpression !== undefined
      && ts.isStringLiteralLike(node.argumentExpression)
      && VIEWER_GLOBALS.has(node.argumentExpression.text)
    ) {
      name = node.argumentExpression.text;
      receiver = node.expression;
    }
    if (name !== undefined && receiver !== undefined) {
      const base = unwrapReceiver(receiver);
      const onGlobal = ts.isIdentifier(base) && (base.text === 'window' || base.text === 'globalThis');
      const isWriteTarget = ts.isBinaryExpression(node.parent)
        && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.parent.left === node;
      if (onGlobal && !isWriteTarget) hits.push({ name, line: lineOf(src, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(src.file);
  return hits;
}

// -- Guard (b): dev-route string literals -----------------------------------

function routeLiterals(src: Source): Array<{ route: string; line: number }> {
  const hits: Array<{ route: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) {
      const route = DEV_ROUTE_PREFIXES.find((p) => node.text.includes(p));
      if (route && !insideDevBranch(node, src.file)) {
        hits.push({ route, line: lineOf(src, node) });
      }
    }
    if (ts.isTemplateExpression(node)) {
      // A template's static heads/tails carry the prefix when a route is built
      // from a base plus an id; its substitutions are visited separately.
      const chunks = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      const route = DEV_ROUTE_PREFIXES.find((p) => chunks.some((c) => c.includes(p)));
      if (route && !insideDevBranch(node, src.file)) {
        hits.push({ route, line: lineOf(src, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src.file);
  return hits;
}

// -- Cases -------------------------------------------------------------------

describe('dev-only globals (guard a)', () => {
  const { names, owners } = devOnlyGlobals();

  it('collects the DEV-only globals from main.ts rather than pinning a list', () => {
    // Not an exhaustive pin - a GROWN set must not fail this case, that is the
    // whole design. These are the ones that existed when the guard was written;
    // losing one silently would mean the collector stopped seeing the block.
    expect([...names].sort()).toEqual(expect.arrayContaining([
      '__rvInstruction', '__rvMuComputeBench', '__rvPerfProbe', '__rvProtoFlags',
      '__rvSyntheticLine', '__rvSyntheticLoad',
    ]));
    // `window.viewer` (main.ts, outside any DEV branch) is installed
    // UNCONDITIONALLY and is not a DEV global - if it ever shows up here, the
    // DEV-branch test has broken open and the guard would flag honest readers.
    expect(names.has('viewer')).toBe(false);
    // `__rvViewer` is in the same position since 2026-10-25: a plain alias of
    // `window.viewer`, published in every build, deliberately NOT gated. It was
    // in the list above until then. Guard (c) is what covers it now; if it
    // reappears here, someone re-gated the alias and the trap is back.
    expect(names.has('__rvViewer')).toBe(false);
  });

  it('every allow-list entry carries a reason', () => {
    for (const entry of GLOBAL_READERS) {
      expect(entry.reason.trim().length, `no reason for ${entry.file}`).toBeGreaterThan(40);
    }
  });

  it('no module reads a DEV-only global outside the allow-list', () => {
    const allowed = new Set(GLOBAL_READERS.map((e) => e.file));
    const offenders: string[] = [];
    for (const src of SOURCES) {
      // `main.ts` installs them, and the module that installs one owns its name.
      if (src.id === 'src/main.ts' || allowed.has(src.id)) continue;
      for (const hit of globalReads(src, names)) {
        if (owners.get(hit.name) === src.id) continue;
        offenders.push(`${src.id}:${hit.line} reads .${hit.name}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('the viewer globals (guard c)', () => {
  it('every allow-list entry carries a reason', () => {
    for (const entry of VIEWER_GLOBAL_READERS) {
      expect(entry.reason.trim().length, `no reason for ${entry.file}`).toBeGreaterThan(40);
    }
  });

  it('the detector reads code, not prose', () => {
    // The permanent half of the negative probe (the other half was run by hand
    // on 2026-10-25 with a throwaway file under src/, and is what proved the
    // failure message names file and line).
    //
    // Fixture order matters: the forbidden read sits on a KNOWN line, and the
    // decoys around it are the exact shapes that make a text search lie - a
    // comment naming the global, a string containing it, a `.viewer` on an
    // honest object, and the assignment in `main.ts`' own spelling.
    const probe = parseText('src/__probe.ts', [
      '// window.viewer must not be read here - this comment names it on purpose.',
      '/** `window.__rvViewer` in a doc comment, explaining the defect. */',
      'const label = "window.viewer";',
      'const fromContext = ctx.viewer;',
      'const fromProps = props["viewer"];',
      '(window as unknown as { viewer?: unknown }).viewer = v;',
      'const bad = (window as unknown as { viewer?: unknown }).viewer;',
      'const alsoBad = window.__rvViewer?.scene;',
      "const spelt = globalThis['viewer'];",
    ].join('\n'));
    expect(viewerGlobalReads(probe)).toEqual([
      { name: 'viewer', line: 7 },
      { name: '__rvViewer', line: 8 },
      { name: 'viewer', line: 9 },
    ]);
  });

  it('no module under src/ reads a viewer global outside the allow-list', () => {
    const allowed = new Set(VIEWER_GLOBAL_READERS.map((e) => e.file));
    const offenders: string[] = [];
    for (const src of SOURCES) {
      // `main.ts` installs both names; its assignments are not reads anyway.
      if (src.id === 'src/main.ts' || allowed.has(src.id)) continue;
      for (const hit of viewerGlobalReads(src)) {
        offenders.push(`${src.id}:${hit.line} reads window.${hit.name}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('`main.ts` publishes `__rvViewer` as an alias, ungated, in every build', () => {
    // The other half of the contract: the ban above is only tolerable because
    // the official handle exists everywhere. Asserted on the AST - both names
    // are assigned the same identifier, and neither assignment sits in a
    // build-mode branch.
    const main = parse(join(root, 'src', 'main.ts'), root);
    const assignments: Array<{ name: string; value: string; dev: boolean }> = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)
        && VIEWER_GLOBALS.has(node.left.name.text)
        && ts.isIdentifier(unwrapReceiver(node.left.expression))
      ) {
        assignments.push({
          name: node.left.name.text,
          value: node.right.getText(main.file),
          dev: insideDevBranch(node, main.file),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(main.file);
    expect(assignments).toEqual([
      { name: 'viewer', value: 'viewer', dev: false },
      { name: '__rvViewer', value: 'viewer', dev: false },
    ]);
  });
});

describe('dev-server routes (guard b)', () => {
  it('every allow-list entry carries a reason', () => {
    for (const entry of ROUTE_OWNERS) {
      expect(entry.reason.trim().length, `no reason for ${entry.file}`).toBeGreaterThan(40);
    }
  });

  it('a dev-server route is named only in a DEV branch or by a listed owner', () => {
    const allowed = new Set(ROUTE_OWNERS.map((e) => e.file));
    const offenders: string[] = [];
    for (const src of SOURCES) {
      if (!/^src\/(core|plugins)\//.test(src.id) || allowed.has(src.id)) continue;
      for (const hit of routeLiterals(src)) {
        offenders.push(`${src.id}:${hit.line} names ${hit.route} outside a DEV branch`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it("the debug endpoint plugin's only importer is main.ts' DEV branch", () => {
    // The reason its allow-list entry gives, made checkable.
    //
    // The expectation names the file and the gate and NOT the line. It used to
    // pin `src/main.ts:2600:DEV` and was already failing at HEAD on 2026-10-25
    // (the import had moved to line 2607, four commits earlier, with nobody
    // learning anything from the red): the position of an import in a 2700-line
    // boot file is not the property this case is about.
    const importers: string[] = [];
    for (const src of SOURCES) {
      if (src.id === 'src/plugins/debug-endpoint-plugin.ts') continue;
      const visit = (node: ts.Node) => {
        const spec = ts.isImportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
        if (spec && ts.isStringLiteralLike(spec) && spec.text.endsWith('debug-endpoint-plugin')) {
          importers.push(`${src.id}:${insideDevBranch(node, src.file) ? 'DEV' : 'UNGATED'}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(src.file);
    }
    expect(importers).toEqual(['src/main.ts:DEV']);
  });

  it('the Tests tab is gated on the probed capability, not on the build mode', () => {
    // The actual regression, asserted where it was introduced: the tab's `Tab`
    // element and its mount both carry the capability gate, and the panel
    // carries no build-mode flag at all (which would break remote dev, plan-383).
    const panel = readFileSync(join(root, 'src/core/hmi/SettingsPanel.tsx'), 'utf8');
    expect(panel).toContain(
      "if (!isMobile && !isTabLocked('tests') && devTestApi !== null) orderedTabs.push({ order: 910, id: 'tests', value: 7, el: <Tab key=\"tests\" label=\"Tests\" value={7} /> });",
    );
    expect(panel).toContain(
      "{settingsTab === 7 && !isTabLocked('tests') && devTestApi !== null && <TestsTab />}",
    );
    expect(panel).not.toMatch(BUILD_MODE_FLAG);
  });
});
