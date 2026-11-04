// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-resolution.ts — one central answer to "can this AAS link actually be
 * resolved?", written onto the node and read by every AAS surface.
 *
 * ## Why this exists
 *
 * A deployment may ship AAS links without shipping the AASX payload. The CONNECT
 * embedded demo is the standard case: the bundler strips the whole `aasx/` folder
 * (index + files), so every motor in the demo carries a link that can never
 * resolve. Before this module each surface asked the parser on its own — and each
 * one rendered its own red `AAS ID not found in index` on hover.
 *
 * The resolvability is therefore determined ONCE, against the active AAS source
 * (`getActiveAasSource()`: project `aasx/` over the deploy-wide directory,
 * plan-596), and stored on the node as
 * `userData._rvAasResolution`. Tooltip, detail panel, inspector button, doc-mode
 * click, sidebar counter and the "Add to Cart" action all read that one marking,
 * so they can never disagree.
 *
 * ## Contract
 *
 * | state            | meaning                                   | UI            |
 * |------------------|-------------------------------------------|---------------|
 * | `resolved`       | index available, id known                 | show          |
 * | `unknown-id`     | index available, id not in it              | hide          |
 * | `index-missing`  | index not shipped (404 / SPA fallback)     | hide          |
 * | `index-error`    | network / 5xx / broken JSON                | VISIBLE error |
 * | `pending`        | not determined yet                         | render nothing|
 *
 * Hiding on `index-error` would mask a broken deployment, so that state keeps its
 * visible error. `pending` renders nothing rather than flashing a tile that then
 * disappears.
 *
 * ## Staleness
 *
 * The index load is async. Switching models while it is in flight would otherwise
 * classify model B's nodes against model A's `assetsBasePath`. Every pass carries
 * the load generation it started in and drops its result when that generation is
 * no longer current — the same guard the viewer uses for its own load races.
 */

import type { Object3D } from 'three';
import type { AasIndexResult } from './aas-link-parser';
import {
  asAasSource,
  getActiveAasSource,
  setAasDeployContext,
  subscribeAasSources,
  type AasSource,
} from '../core/aas/rv-aas-source';

// ─── Node marking (aas-resolution-mark.ts, re-exported) ────────────────

// The marking lives in its own module so the scene loader can mark nodes
// without pulling the active-source machinery (project store) into its graph.
import { AAS_RESOLUTION_KEY, markAasPending, isAasNodeVisible as isAasNodeVisibleLocal, type AasResolution } from './aas-resolution-mark';
export {
  AAS_RESOLUTION_KEY,
  getAasResolution,
  isAasNodeVisible,
  isAasUnresolvable,
  isAasVisible,
  markAasPending,
  type AasResolution,
} from './aas-resolution-mark';

/**
 * Minimal viewer surface this module needs — keeps it testable without a full
 * RVViewer. `on` is typed loosely on purpose: RVViewer's overloaded, event-keyed
 * signature is not assignable to a narrow structural one.
 */
interface AasResolutionViewer {
  scene?: Object3D;
  projectAssetsPath?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on?: (event: any, handler: any) => unknown;
}

// ─── Shown AAS nodes (the one count) ────────────────────────────────────

/**
 * Every AASLink node under `root` that can actually be shown
 * (`isAasNodeVisible`). The ONE source for "does this document have AAS" —
 * AAS button counter, AAS mode and the Order Cart button all read it
 * (plan-682 F2). `out` is cleared and reused when given (no garbage on rebuild).
 */
export function collectAasNodes(root: Object3D | null | undefined, out: Object3D[] = []): Object3D[] {
  out.length = 0;
  if (!root) return out;
  root.traverse((node) => {
    if (node.userData?._rvAasLink && isAasNodeVisibleLocal(node)) out.push(node);
  });
  return out;
}

// ─── Load generation (stale-completion guard) ───────────────────────────

let _generation = 0;

/** Start a new load generation; every pass started earlier is discarded. */
export function beginAasLoadGeneration(): number {
  return ++_generation;
}

/** The generation a pass should carry when it is not tied to a model load. */
export function currentAasLoadGeneration(): number {
  return _generation;
}

// ─── Change notification ────────────────────────────────────────────────

const listeners = new Set<() => void>();
let version = 0;

/** Subscribe to "a resolution pass finished" — for `useSyncExternalStore`. */
export function subscribeAasResolution(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Monotonic counter bumped after every completed pass. */
export function getAasResolutionVersion(): number {
  return version;
}

function notifyResolution(): void {
  version++;
  for (const l of listeners) l();
}

// ─── Resolution pass ────────────────────────────────────────────────────

/** Classify one AAS id against an index result. */
export function classifyAas(result: AasIndexResult, aasId: string): AasResolution {
  if (result.kind === 'missing') return 'index-missing';
  if (result.kind === 'error') return 'index-error';
  return aasId && result.index[aasId] ? 'resolved' : 'unknown-id';
}

/** Deduplicates repeat passes over the same root within one generation + source revision. */
const passes = new WeakMap<Object3D, { passKey: string; generation: number; promise: Promise<void> }>();

/**
 * Mark every AAS node under `root` with its resolution. Safe to call repeatedly:
 * a second call with the same root, source revision and generation joins the
 * first pass instead of re-traversing.
 *
 * @param source     the AAS source to classify against: an {@link AasSource}
 *                   (normally `getActiveAasSource()`), or a legacy assets-root
 *                   string; `undefined` = the default deploy directory.
 * @param generation load generation this pass belongs to; results are dropped
 *                   when a newer load started in the meantime.
 */
export function resolveAasSubtree(
  root: Object3D | null | undefined,
  source: AasSource | string | undefined,
  generation: number,
): Promise<void> {
  if (!root) return Promise.resolve();

  const src = asAasSource(source);
  // The source REVISION is part of the key (plan-596 SOL #6): after a scan or an
  // import changed the index, the same root must be classified again.
  const revision = src.revision;
  const passKey = `${src.key}#${revision}`;
  const cached = passes.get(root);
  if (cached && cached.passKey === passKey && cached.generation === generation) return cached.promise;

  const nodes: Object3D[] = [];
  root.traverse((node) => {
    if (!node.userData?._rvAasLink) return;
    markAasPending(node);
    nodes.push(node);
  });
  if (nodes.length === 0) return Promise.resolve();

  const promise = src.readIndex().then((result) => {
    // A newer model load started while the index was in flight: its nodes must
    // not be classified against this (now foreign) source.
    if (generation !== _generation) return;
    // The index changed while this pass read it: a newer pass (started by the
    // change notification) owns the answer, this one is stale.
    if (src.revision !== revision) return;
    for (const node of nodes) {
      const aasId = (node.userData._rvAasLink as { aasId?: string } | undefined)?.aasId ?? '';
      (node.userData as Record<string, unknown>)[AAS_RESOLUTION_KEY] = classifyAas(result, aasId);
    }
    notifyResolution();
  });

  passes.set(root, { passKey, generation, promise });
  return promise;
}

/**
 * Wire the resolution to the viewer lifecycle so it runs in EVERY mode — the AAS
 * plugin is not loaded in the layout planner, and a link attached there would
 * otherwise stay `'pending'` (i.e. invisible) forever.
 *
 * Returns a disposer. Idempotent per viewer is the caller's business; boot calls
 * it exactly once.
 */
export function installAasResolution(viewer: AasResolutionViewer): () => void {
  const offs: Array<() => void> = [];

  const off1 = viewer.on?.('model-loaded', (payload: { result?: { root?: Object3D; modelConfig?: unknown } }) => {
    const result = payload?.result;
    if (!result?.root) return;
    // The model's own explicit aasx base and the deploy root feed the ONE active
    // source (plan-596) that every AAS surface reads.
    setAasDeployContext({
      explicitBase: explicitAasBaseOf(result.modelConfig) ?? null,
      deployBase: viewer.projectAssetsPath ?? null,
    });
    void resolveAasSubtree(result.root, getActiveAasSource(), beginAasLoadGeneration());
  });
  if (typeof off1 === 'function') offs.push(off1 as () => void);

  const off2 = viewer.on?.('layout-content-added', (payload: { root?: Object3D }) => {
    if (!payload?.root) return;
    void resolveAasSubtree(payload.root, getActiveAasSource(), currentAasLoadGeneration());
  });
  if (typeof off2 === 'function') offs.push(off2 as () => void);

  // A source changed its index (project scan, import, project switch): classify
  // the whole scene again against the active source (missing -> available after
  // the first index write, resolved -> unknown-id after a removal).
  offs.push(subscribeAasSources(() => {
    if (!viewer.scene) return;
    void resolveAasSubtree(viewer.scene, getActiveAasSource(), currentAasLoadGeneration());
  }));

  // The project AASX scan follows the open project (plan-596 Phase 3). Loaded
  // lazily: the scanner and the zip reader stay off the entry chunk.
  let disposed = false;
  void import('../core/aas/rv-aasx-project-index')
    .then((m) => { if (!disposed) offs.push(m.installAasxProjectIndex()); })
    .catch((e) => console.warn('[aas-resolution] project AASX index unavailable', e));

  return () => { disposed = true; for (const off of offs) off(); offs.length = 0; };
}

/** The explicit per-model `assetsBasePath` of the `aas-link` plugin config, if any. */
export function explicitAasBaseOf(modelConfig: unknown): string | undefined {
  const cfg = (modelConfig as { pluginConfig?: Record<string, { assetsBasePath?: string } | undefined> } | undefined)
    ?.pluginConfig?.['aas-link'];
  return cfg?.assetsBasePath;
}

/**
 * The assets ROOT the deploy-wide AASX are served from: the model's own
 * `aas-link` plugin config wins, otherwise the deployment-wide project assets
 * path. Kept for callers outside the AAS chain; the chain itself reads
 * `getActiveAasSource()` since plan-596.
 */
export function aasBasePathFor(viewer: AasResolutionViewer, modelConfig: unknown): string | undefined {
  const cfg = (modelConfig as { pluginConfig?: Record<string, { assetsBasePath?: string } | undefined> } | undefined)
    ?.pluginConfig?.['aas-link'];
  return cfg?.assetsBasePath ?? viewer.projectAssetsPath;
}

/** Reset module state — tests only. */
export function resetAasResolution(): void {
  _generation = 0;
  version = 0;
  listeners.clear();
}
