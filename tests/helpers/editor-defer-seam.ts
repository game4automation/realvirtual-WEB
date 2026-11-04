// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-defer-seam — the TEST-ONLY seam behind the editor harness's two load
 * modes (`editor-document-harness.ts`).
 *
 * Since plan-774 Phase 2 the production editor load DEFERS every non-embedded
 * reference (`loadGLB` hands `compose()` `deferReference = !ref.embedded`
 * whenever `deferPlacements`, which `RVViewer.loadModel` always sets). The
 * harness's `'graft'` mode keeps covering compose's GRAFT through the real
 * viewer — the load shape of every build before Phase 2, i.e. how an older
 * build opens a file this one wrote: while the harness raises the flag, the
 * seam strips `deferReference` from the compose call, so every reference is
 * grafted exactly as before. Without the flag every call passes through
 * untouched (the `'deferred'` mode IS the production load).
 *
 * Usage (must sit in the TEST file, `vi.mock` is hoisted per file):
 *
 *   vi.mock('../src/core/engine/rv-glb-compose', async (importOriginal) =>
 *     (await import('./helpers/editor-defer-seam')).deferringComposeModule(importOriginal));
 *
 * This module imports nothing from the engine, so the mock factory can load it
 * without a cycle.
 */

type ComposeFn = (root: unknown, options: { deferReference?: unknown } & Record<string, unknown>) => Promise<unknown>;

interface SeamGlobals {
  __rv774DeferSeamInstalled?: boolean;
  __rv774ForceAuthoringGraft?: boolean;
  __rv774ComposeTemplateRoots?: unknown[];
}

const g = globalThis as unknown as SeamGlobals;

/** The parse-template roots a compose cache holds (its `templates` map is private). */
function templateRootsOf(cache: unknown): unknown[] {
  const templates = (cache as { templates?: Map<string, { root: unknown }> } | null | undefined)?.templates;
  return templates ? [...templates.values()].map((t) => t.root) : [];
}

/** The mock factory body: the real module with `compose` wrapped. */
export async function deferringComposeModule<M extends { compose: ComposeFn }>(
  importOriginal: () => Promise<M>,
): Promise<M> {
  const actual = await importOriginal();
  g.__rv774DeferSeamInstalled = true;
  // Records, when compose returns (its overrides already applied to the
  // clones), the template roots its cache holds — plan-774 review fix #10d
  // checks they never carry a runtime override base.
  const record = (options: Record<string, unknown>) => (result: unknown): unknown => {
    const cache = options.cache ?? (result as { ownedCache?: unknown } | null)?.ownedCache;
    (g.__rv774ComposeTemplateRoots ??= []).push(...templateRootsOf(cache));
    return result;
  };
  const compose: ComposeFn = (root, options) => {
    if (g.__rv774ForceAuthoringGraft && options.deferReference !== undefined) {
      return actual.compose(root, { ...options, deferReference: undefined }).then(record(options));
    }
    return actual.compose(root, options).then(record(options));
  };
  return { ...actual, compose };
}

/** Template roots of every compose cache seen since the last call (and clears the list). */
export function takeComposeTemplateRoots(): unknown[] {
  const roots = g.__rv774ComposeTemplateRoots ?? [];
  g.__rv774ComposeTemplateRoots = [];
  return roots;
}

/** True once a test file installed the seam (its module was imported through the mock). */
export function deferSeamInstalled(): boolean {
  return g.__rv774DeferSeamInstalled === true;
}

/** Raise the graft flag around `fn` only — compose runs inside `loadGLB`, before `loadModel` resolves. */
export async function withForcedAuthoringGraft<T>(fn: () => Promise<T>): Promise<T> {
  g.__rv774ForceAuthoringGraft = true;
  try {
    return await fn();
  } finally {
    g.__rv774ForceAuthoringGraft = false;
  }
}
