// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 §9.5, guard 2 — the READ side of thumbnails cannot reach a renderer
 * or a GLB loader, not even lazily.
 *
 * Cards read the pointer a save wrote; they never render. The day a card grows
 * an `import('…/thumbnail-renderer')` "for the missing ones", render-on-view
 * is back — so this walks the guarded files' imports, STATIC AND DYNAMIC
 * (`eagerGraph` of `helpers/static-import-graph.ts` follows static value
 * imports only, and a lazy import is exactly the regression to catch).
 *
 * ## The walk's reach
 *
 * Transitively through the read side itself — every file of the guarded set —
 * and one step out: every module a guarded file imports is checked against the
 * forbidden list, but the walk does not descend into the rest of the app. It
 * cannot: the project store reaches the scene bake and with it the model cache
 * and GLTFLoader through the save path, which is legitimate there. What this
 * guard owns is that nothing the READ side writes leads to a renderer.
 *
 * And the other direction: only the one post-save step every save path ends in
 * (`rv-finish-document-save.ts`, plan-777 P4), the "Regenerate
 * thumbnails" loop (plan-776 #20) and the writer itself may import the
 * renderer / writer / content rule (exact set, so a new importer fails here) —
 * the renderer itself imports the content rule. The loop is imported by its
 * command module alone, and only lazily.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  REPO_ROOT,
  dynamicSpecifiers,
  norm,
  resolveSpec,
  staticSpecifiers,
} from './helpers/static-import-graph';

const SRC = resolve(REPO_ROOT, 'src');

function walkDir(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walkDir(abs));
    else if (/\.(ts|tsx)$/.test(name)) out.push(abs);
  }
  return out;
}

/** The read side: dashboard cards, the library, the planner panel, the URL store. */
const GUARDED: string[] = [
  ...walkDir(resolve(SRC, 'core/hmi/projects')),
  ...walkDir(resolve(SRC, 'core/library')),
  resolve(SRC, 'plugins/layout-planner/LayoutLibraryPanel.tsx'),
  resolve(SRC, 'core/thumbnails/rv-thumbnail-url-store.ts'),
];
const GUARDED_SET = new Set(GUARDED.map(norm));

/** Modules the read side must never reach (by resolved path, or package specifier). */
const FORBIDDEN: RegExp[] = [
  /\/core\/thumbnails\/thumbnail-renderer\.ts$/,
  /\/core\/thumbnails\/rv-thumbnail-write\.ts$/,
  // The content rule + capture clone of the save-time render.
  /\/core\/thumbnails\/thumbnail-content\.ts$/,
  // The "Regenerate thumbnails" loop (plan-776 #20): it opens documents and
  // calls the writer. The dashboard reaches only its light command module
  // (rv-thumbnail-regenerate-commands.ts) and dispatches the command by id.
  /\/core\/thumbnails\/rv-thumbnail-regenerate\.ts$/,
  /\/core\/engine\/rv-model-cache\.ts$/,
  /\/plugins\/layout-planner\/model-cache\.ts$/,
  // The engine's GLB parse entry point — it IS the GLTFLoader wrapper.
  /\/core\/engine\/rv-glb-parse\.ts$/,
  /^three\/addons\/loaders\/GLTFLoader(\.js)?$/,
  /^three\/examples\/jsm\/loaders\/GLTFLoader(\.js)?$/,
];

function specifiersOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...staticSpecifiers(src), ...dynamicSpecifiers(src)];
}

/** Every forbidden module reachable from `entry`, with the chain that reaches it. */
function forbiddenReach(entry: string): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const stack: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [norm(entry)] }];
  while (stack.length > 0) {
    const { file, chain } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      const resolved = resolveSpec(file, spec);
      const target = resolved ? norm(resolved) : spec;
      if (FORBIDDEN.some((re) => re.test(target))) {
        hits.push([...chain, target].map((p) => p.replace(norm(REPO_ROOT), '')).join(' -> '));
        continue;
      }
      // Recurse only through the read side itself (see the file doc).
      if (resolved && GUARDED_SET.has(norm(resolved))) {
        stack.push({ file: resolved, chain: [...chain, norm(resolved)] });
      }
    }
  }
  return hits;
}

describe('thumbnail read side — import boundary (plan-776 guard 2)', () => {
  it('the guarded set is the read side it claims to be', () => {
    expect(GUARDED.length).toBeGreaterThan(20);
    expect(GUARDED.some((f) => norm(f).endsWith('/core/hmi/projects/ProjectCard.tsx'))).toBe(true);
    expect(GUARDED.some((f) => norm(f).endsWith('/core/library/resolve-document-thumbnail.ts'))).toBe(true);
  });

  for (const file of GUARDED) {
    const rel = norm(file).replace(norm(REPO_ROOT) + '/', '');
    it(`${rel} reaches no renderer, writer, model cache or GLTFLoader (static or dynamic)`, () => {
      expect(forbiddenReach(file)).toEqual([]);
    });
  }

  it('the walk catches a lazy renderer import (the matcher is live)', () => {
    const probe = "const r = await import('../thumbnails/thumbnail-renderer');";
    const from = resolve(SRC, 'core/library/x.ts');
    const targets = dynamicSpecifiers(probe).map((s) => norm(resolveSpec(from, s) ?? s));
    expect(targets.some((t) => FORBIDDEN.some((re) => re.test(t)))).toBe(true);
  });

  it('only the post-save step imports the renderer, the writer or the content rule — the exact set', () => {
    const importers = new Set<string>();
    for (const file of walkDir(SRC)) {
      for (const spec of specifiersOf(file)) {
        const resolved = resolveSpec(file, spec);
        if (!resolved) continue;
        if (/\/core\/thumbnails\/(thumbnail-renderer|rv-thumbnail-write|thumbnail-content)\.ts$/.test(norm(resolved))) {
          importers.add(norm(file).replace(norm(SRC) + '/', ''));
        }
      }
    }
    expect([...importers].sort()).toEqual([
      'core/editor/rv-finish-document-save.ts',
      'core/thumbnails/rv-thumbnail-regenerate.ts',
      'core/thumbnails/rv-thumbnail-write.ts',
      'core/thumbnails/thumbnail-renderer.ts',
    ]);
  });

  it('plan-776 #20: only the command module loads the regenerate loop, and only lazily', () => {
    const isLoop = (r: string) => /\/core\/thumbnails\/rv-thumbnail-regenerate\.ts$/.test(r);
    const lazyImporters: string[] = [];
    for (const file of walkDir(SRC)) {
      const src = readFileSync(file, 'utf8');
      const rel = norm(file).replace(norm(SRC) + '/', '');
      const resolveAll = (specs: string[]) =>
        specs.map((s) => resolveSpec(file, s)).filter((r): r is string => !!r).map(norm);
      // A STATIC value import would pull the writer into whoever imports the command module.
      expect(resolveAll(staticSpecifiers(src)).some(isLoop), `${rel} imports the loop statically`).toBe(false);
      if (resolveAll(dynamicSpecifiers(src)).some(isLoop)) lazyImporters.push(rel);
    }
    expect(lazyImporters).toEqual(['core/thumbnails/rv-thumbnail-regenerate-commands.ts']);
  });

  it('the render-on-view modules are gone', () => {
    for (const rel of [
      'core/thumbnails/thumbnail-service.ts',
      'core/thumbnails/thumbnail-cache.ts',
      'core/thumbnails/thumbnail-key.ts',
      'core/thumbnails/use-asset-thumbnail.ts',
      'core/thumbnails/use-thumbnail-visibility.ts',
      'plugins/layout-planner/planner-thumbnail-key.ts',
    ]) {
      expect(existsSync(resolve(SRC, rel)), rel).toBe(false);
    }
  });
});
