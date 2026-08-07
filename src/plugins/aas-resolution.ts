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
 * The resolvability is therefore determined ONCE, where the project-specific
 * `assetsBasePath` is known (the model load), and stored on the node as
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
import { loadIndexResult, type AasIndexResult } from './aas-link-parser';

// ─── Types ──────────────────────────────────────────────────────────────

/** Resolution state of a single AAS link. Stored as `node.userData._rvAasResolution`. */
export type AasResolution =
  | 'resolved'
  | 'unknown-id'
  | 'index-missing'
  | 'index-error'
  | 'pending';

/** userData key carrying the resolution. Kept as a constant so tests cannot drift. */
export const AAS_RESOLUTION_KEY = '_rvAasResolution';

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

// ─── Node marking ───────────────────────────────────────────────────────

/**
 * Read a node's AAS resolution. A node that carries an AAS link but no marking
 * yet counts as `'pending'` — never as resolved, so nothing is shown before the
 * index answered.
 */
export function getAasResolution(node: Object3D | null | undefined): AasResolution {
  const raw = node?.userData?.[AAS_RESOLUTION_KEY] as AasResolution | undefined;
  return raw ?? 'pending';
}

/**
 * True when every AAS surface must stay silent for this state: the id is unknown
 * or the index was never shipped. `'pending'` is handled by {@link isAasVisible}
 * (render nothing, but it is not a final answer).
 */
export function isAasUnresolvable(resolution: AasResolution): boolean {
  return resolution === 'unknown-id' || resolution === 'index-missing';
}

/** True when an AAS surface may render for this state (`resolved` or a visible error). */
export function isAasVisible(resolution: AasResolution): boolean {
  return resolution === 'resolved' || resolution === 'index-error';
}

/** True when the node carries an AAS link that may be shown. */
export function isAasNodeVisible(node: Object3D | null | undefined): boolean {
  return isAasVisible(getAasResolution(node));
}

/**
 * Mark a node as not-yet-classified. Called synchronously wherever an AAS link is
 * attached, so an unmarked AAS node never exists — a node without a marking would
 * otherwise be indistinguishable from one that resolved.
 */
export function markAasPending(node: Object3D | null | undefined): void {
  if (!node) return;
  const ud = node.userData as Record<string, unknown>;
  if (ud[AAS_RESOLUTION_KEY] === undefined) ud[AAS_RESOLUTION_KEY] = 'pending';
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

/** Deduplicates repeat passes over the same root within one generation + basePath. */
const passes = new WeakMap<Object3D, { basePath: string; generation: number; promise: Promise<void> }>();

/**
 * Mark every AAS node under `root` with its resolution. Safe to call repeatedly:
 * a second call with the same root, basePath and generation joins the first pass
 * instead of re-traversing.
 *
 * @param generation load generation this pass belongs to — results are dropped
 *                   when a newer load started in the meantime.
 */
export function resolveAasSubtree(
  root: Object3D | null | undefined,
  assetsBasePath: string | undefined,
  generation: number,
): Promise<void> {
  if (!root) return Promise.resolve();

  const key = assetsBasePath ?? '';
  const cached = passes.get(root);
  if (cached && cached.basePath === key && cached.generation === generation) return cached.promise;

  const nodes: Object3D[] = [];
  root.traverse((node) => {
    if (!node.userData?._rvAasLink) return;
    markAasPending(node);
    nodes.push(node);
  });
  if (nodes.length === 0) return Promise.resolve();

  const promise = loadIndexResult(assetsBasePath).then((result) => {
    // A newer model load started while the index was in flight — its nodes must
    // not be classified against this (now foreign) basePath.
    if (generation !== _generation) return;
    for (const node of nodes) {
      const aasId = (node.userData._rvAasLink as { aasId?: string } | undefined)?.aasId ?? '';
      (node.userData as Record<string, unknown>)[AAS_RESOLUTION_KEY] = classifyAas(result, aasId);
    }
    notifyResolution();
  });

  passes.set(root, { basePath: key, generation, promise });
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
    void resolveAasSubtree(result.root, aasBasePathFor(viewer, result.modelConfig), beginAasLoadGeneration());
  });
  if (typeof off1 === 'function') offs.push(off1 as () => void);

  const off2 = viewer.on?.('layout-content-added', (payload: { root?: Object3D }) => {
    if (!payload?.root) return;
    void resolveAasSubtree(payload.root, aasBasePathFor(viewer, undefined), currentAasLoadGeneration());
  });
  if (typeof off2 === 'function') offs.push(off2 as () => void);

  return () => { for (const off of offs) off(); offs.length = 0; };
}

/**
 * The base path AASX assets are served from: the model's own `aas-link` plugin
 * config wins, otherwise the deployment-wide project assets path. Reading it here
 * is what keeps a customer-specific AAS from being checked against the default
 * index (and then wrongly hidden).
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
