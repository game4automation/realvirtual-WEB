// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-parametric-regenerate — the asset-editor path of a parametric family
 * (plan-650 Phase 4, §2.6 "Editor-Pfad", F7).
 *
 * Changing the values of a family is ONE undo step (`withTransaction`):
 *
 *   deleteNode(_Generated)
 *   → importCad(GLB of the new variant)      — cached under (InputHash, 'param-v2', 'parametric')
 *   → reparentNode under the family node     — importCad always attaches at the model root
 *   → transformNode to the variant's local TRS (reparent keeps the WORLD pose)
 *   → renameNode back to `_Generated` when a sibling forced a unique name
 *   → setField Values + BakedInputHash
 *
 * The op log carries only the hash (geometry by cache key, like every CAD
 * import). A draft replay whose cache entry is gone asks the CAD provider of
 * format `'parametric'` — registered by `rv-parametric-component.ts` — which
 * rebuilds the variant from the family's base parts and the values stored in
 * `CADLink.Parametric` ({@link rebuildParametricGlb}). Deterministic generator
 * → the same tree as the original.
 *
 * The generator never runs while the simulation runs (§2.6a): a request at a
 * running simulation is deferred and applied at the next standstill.
 *
 * Loaded by dynamic import only (inspector commit, MCP tools, replay rebuild).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { AssetDocument } from './rv-asset-document';
import { assetOpHeader, type CADLinkExtras, type NodeTransform } from './rv-asset-ops';
import { NodeRegistry } from '../engine/rv-node-registry';
import { getCadGlb, putCadGlb, type CadCacheTier } from '../import/rv-cad-glb-cache';
import { objectToGlb } from '../import/rv-import-object';
import { weldImportedGlb } from '../import/rv-glb-weld';
import { PARAMETRIC_COMPONENT_TYPE, type ParamValue } from '../engine/rv-parametric-component';
import {
  buildVariant,
  canRegenerate,
  childNamed,
  resolveFamilyInputs,
  type VariantError,
} from '../engine/rv-parametric-family';
import { clearProblem, reportProblem } from '../hmi/problems-store';

/** Fixed quality token of every parametric cache entry (§2.6, R2-Finding 6). */
export const PARAMETRIC_CACHE_QUALITY = 'param-v2';
/** Problem code of a refused hand-attach under `_Generated` (F10). */
export const PROBLEM_MANUAL_ATTACH = 'parametric-manual-attach';
/** Problem code of a failed regeneration. */
export const PROBLEM_REGENERATE_FAILED = 'parametric-regenerate-failed';

// ─── Paths ───────────────────────────────────────────────────────────────

/** Path of `node` relative to `modelRoot` (`''` = the root itself), or null when outside. */
export function relativeFamilyPath(modelRoot: Object3D, node: Object3D): string | null {
  const names: string[] = [];
  let n: Object3D | null = node;
  while (n && n !== modelRoot) {
    names.unshift(n.name);
    n = n.parent;
  }
  return n === modelRoot ? names.join('/') : null;
}

/** Resolve a {@link relativeFamilyPath} below `modelRoot`, or null. */
export function resolveFamilyPath(modelRoot: Object3D, rel: string): Object3D | null {
  if (rel === '') return modelRoot;
  let n: Object3D | null = modelRoot;
  for (const name of rel.split('/')) {
    n = n ? childNamed(n, name) : null;
  }
  return n;
}

function transformOf(node: Object3D): NodeTransform {
  return {
    position: node.position.toArray() as [number, number, number],
    quaternion: node.quaternion.toArray() as [number, number, number, number],
    scale: node.scale.toArray() as [number, number, number],
  };
}

function sameTransform(a: NodeTransform, b: NodeTransform): boolean {
  const eq = (x: readonly number[], y: readonly number[]) => x.every((v, i) => Math.abs(v - y[i]) < 1e-9);
  return eq(a.position, b.position) && eq(a.quaternion, b.quaternion) && eq(a.scale, b.scale);
}

function sameValues(a: Readonly<Record<string, unknown>> | undefined, b: Readonly<Record<string, unknown>>): boolean {
  if (!a) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && kb.every((k) => a[k] === b[k]);
}

// ─── Regenerate ──────────────────────────────────────────────────────────

export interface RegenerateContext {
  viewer: RVViewer;
  doc: AssetDocument;
}

export interface RegenerateOptions {
  /** Regenerate even when the values hash equals `BakedInputHash`. */
  force?: boolean;
}

export type RegenerateOutcome =
  | {
      status: 'applied';
      familyPath: string;
      generatedPath: string;
      inputHash: string;
      values: Record<string, ParamValue>;
      /** The variant came from the CAD-GLB cache — no generator run. */
      cacheHit: boolean;
      cacheTier: CadCacheTier | null;
      messages: { level: 'info' | 'warning'; text: string }[];
      stats: { instances: number; meshes: number; vertices: number; interruptTicks: number; elapsedMs: number } | null;
    }
  | { status: 'unchanged'; familyPath: string; inputHash: string; values: Record<string, ParamValue> }
  | { status: 'deferred'; familyPath: string; reason: string }
  | { status: 'failed'; familyPath: string; error: VariantError };

/**
 * Regenerate the family at `familyPath` (full registry path) with `values`
 * (partial values are completed by the stored ones, then normalized) as ONE
 * undo step. Never throws for a generator/assembly failure — the old variant
 * stays and the outcome (plus a Problems entry) names the cause.
 */
export async function regenerateParametric(
  ctx: RegenerateContext,
  familyPath: string,
  values?: Readonly<Record<string, unknown>>,
  opts: RegenerateOptions = {},
): Promise<RegenerateOutcome> {
  const { viewer, doc } = ctx;
  const problemId = `${PROBLEM_REGENERATE_FAILED}:${familyPath}`;
  const fail = (error: VariantError): RegenerateOutcome => {
    reportProblem({
      id: problemId, severity: 'error', code: PROBLEM_REGENERATE_FAILED,
      title: `Parametric family could not be regenerated (${error.code})`,
      detail: `${error.message} — the previous variant is kept.`,
      nodePath: familyPath,
    });
    return { status: 'failed', familyPath, error };
  };

  if (!canRegenerate(viewer as never)) {
    deferRegenerate(ctx, familyPath, values, opts);
    return { status: 'deferred', familyPath, reason: 'simulation is running — applied at the next standstill' };
  }

  const modelRoot = viewer.currentModelRoot;
  const family = viewer.registry?.getNode(familyPath) ?? null;
  if (!modelRoot || !family) return fail({ stage: 'input', code: 'not-found', message: `node not found: ${familyPath}` });
  const rel = relativeFamilyPath(modelRoot, family);
  if (rel === null) return fail({ stage: 'input', code: 'not-found', message: `${familyPath} is not part of the open asset` });

  const stored = (family.userData.realvirtual?.[PARAMETRIC_COMPONENT_TYPE] ?? {}) as Record<string, unknown>;
  const merged = { ...((stored.Values ?? {}) as Record<string, unknown>), ...(values ?? {}) };

  let inputs;
  try {
    inputs = await resolveFamilyInputs(family, merged);
  } catch (e) {
    return fail({ stage: 'input', code: 'invalid-input', message: e instanceof Error ? e.message : String(e) });
  }
  const generatedName = inputs.family.generatedRootName;
  const oldGenerated = childNamed(family, generatedName);
  if (!opts.force && oldGenerated && stored.BakedInputHash === inputs.inputHash
      && sameValues(stored.Values as Record<string, unknown> | undefined, inputs.values)) {
    clearProblem(problemId);
    return { status: 'unchanged', familyPath, inputHash: inputs.inputHash, values: inputs.values };
  }

  // F15: a variant already in the CAD-GLB cache needs no generator run.
  let glb = await getCadGlb(inputs.inputHash, PARAMETRIC_CACHE_QUALITY, 'parametric');
  const cacheHit = glb !== null;
  let messages: { level: 'info' | 'warning'; text: string }[] = [];
  let stats: Extract<RegenerateOutcome, { status: 'applied' }>['stats'] = null;
  let localTransform: NodeTransform | null = null;
  if (!glb) {
    const variant = await buildVariant(family, inputs.values);
    if (!variant.ok) return fail(variant.error);
    messages = variant.messages;
    stats = {
      instances: variant.assemblyStats.instances, meshes: variant.assemblyStats.meshes,
      vertices: variant.assemblyStats.vertices, interruptTicks: variant.generatorStats.interruptTicks,
      elapsedMs: variant.elapsedMs,
    };
    localTransform = transformOf(variant.root);
    glb = await objectToGlb(variant.root);
  } else {
    const partsRoot = childNamed(family, inputs.family.partsRootName);
    if (partsRoot) localTransform = transformOf(partsRoot);
  }

  const cadlink: CADLinkExtras = {
    File: `${family.name || 'family'}.parametric`,
    Sha256: inputs.inputHash,
    Quality: PARAMETRIC_CACHE_QUALITY,
    ImportScaleFactor: 1,
    ZIsUpVector: false,
    Converter: 'parametric',
    Parametric: { FamilyPath: rel, Values: { ...inputs.values } },
  };
  const prevValues = stored.Values;
  const prevHash = stored.BakedInputHash;
  const familyIsRoot = family === modelRoot;
  let generatedPath = '';

  try {
    await doc.withTransaction(`Regenerate ${family.name}`, async () => {
      if (oldGenerated) {
        await doc.applyOp({ ...assetOpHeader(), kind: 'deleteNode', nodePath: NodeRegistry.computeNodePath(oldGenerated) });
      }
      let path = await doc.importCad({ glb: glb!, cadlink }, { name: generatedName });
      if (!familyIsRoot) {
        const [moved] = await doc.reparentNodes([path], familyPath);
        path = moved ?? path;
      }
      let node = viewer.registry?.getNode(path) ?? null;
      if (!node) throw new Error(`regenerated subtree vanished: ${path}`);
      const prev = transformOf(node);
      if (localTransform && !sameTransform(prev, localTransform)) {
        await doc.applyOp({ ...assetOpHeader(), kind: 'transformNode', nodePath: path, transform: localTransform, prev });
      }
      if (node.name !== generatedName && !childNamed(family, generatedName)) {
        const renamed = await doc.renameNodeAwaited(path, generatedName);
        path = renamed.path;
        node = viewer.registry?.getNode(path) ?? node;
      }
      generatedPath = path;
      await doc.setFieldAwaited(familyPath, PARAMETRIC_COMPONENT_TYPE, 'Values', { ...inputs.values }, prevValues);
      await doc.setFieldAwaited(familyPath, PARAMETRIC_COMPONENT_TYPE, 'BakedInputHash', inputs.inputHash, prevHash);
    });
  } catch (e) {
    return fail({ stage: 'assembly', code: 'commit-failed', message: e instanceof Error ? e.message : String(e) });
  }
  clearProblem(problemId);
  return {
    status: 'applied', familyPath, generatedPath, inputHash: inputs.inputHash, values: inputs.values,
    cacheHit, cacheTier: null, messages, stats,
  };
}

// ─── Deferral (§2.6a) ────────────────────────────────────────────────────

interface Deferred {
  ctx: RegenerateContext;
  values?: Readonly<Record<string, unknown>>;
  opts: RegenerateOptions;
}

const deferred = new Map<string, Deferred>();
let deferTimer: ReturnType<typeof setInterval> | null = null;
/** Poll period of the standstill check while something is deferred. */
const DEFER_POLL_MS = 500;

/** Families with a deferred regeneration (inspector: "applied when the simulation stops"). */
export function getDeferredFamilies(): string[] {
  return [...deferred.keys()];
}

/** Drop every deferred regeneration (document closed, tests). */
export function clearDeferredRegenerations(): void {
  deferred.clear();
  if (deferTimer) { clearInterval(deferTimer); deferTimer = null; }
}

function deferRegenerate(
  ctx: RegenerateContext, familyPath: string, values: Readonly<Record<string, unknown>> | undefined, opts: RegenerateOptions,
): void {
  // The latest request wins; its values complete the earlier ones.
  const prev = deferred.get(familyPath);
  deferred.set(familyPath, { ctx, values: { ...(prev?.values ?? {}), ...(values ?? {}) }, opts });
  if (!deferTimer) deferTimer = setInterval(() => { void flushDeferredRegenerations(); }, DEFER_POLL_MS);
}

/** Apply every deferred regeneration whose viewer is at a standstill. Returns the outcomes. */
export async function flushDeferredRegenerations(): Promise<RegenerateOutcome[]> {
  const out: RegenerateOutcome[] = [];
  for (const [path, d] of [...deferred]) {
    if (!canRegenerate(d.ctx.viewer as never)) continue;
    deferred.delete(path);
    out.push(await regenerateParametric(d.ctx, path, d.values, d.opts));
  }
  if (deferred.size === 0 && deferTimer) { clearInterval(deferTimer); deferTimer = null; }
  return out;
}

// ─── Replay rebuild (CAD provider 'parametric') ──────────────────────────

/**
 * Rebuild the GLB of a parametric `importCad` whose cache entry is gone:
 * resolve the family from `cadlink.Parametric.FamilyPath`, run generator +
 * assembly with the recorded values, verify the `InputHash` still matches
 * (base parts or code unchanged), cache and return the bytes. Throws with a
 * user-facing reason when the variant cannot be reproduced.
 */
export async function rebuildParametricGlb(cadlink: CADLinkExtras, modelRoot: Object3D | null): Promise<ArrayBuffer> {
  const p = cadlink.Parametric;
  if (!p) throw new Error('parametric variant without CADLink.Parametric — cannot be regenerated');
  if (!modelRoot) throw new Error('no asset loaded to regenerate the parametric variant from');
  const family = resolveFamilyPath(modelRoot, p.FamilyPath);
  if (!family) throw new Error(`parametric family "${p.FamilyPath}" not found in the asset`);
  const variant = await buildVariant(family, p.Values);
  if (!variant.ok) throw new Error(`regenerating "${p.FamilyPath}" failed (${variant.error.code}): ${variant.error.message}`);
  const glb = weldImportedGlb(await objectToGlb(variant.root), cadlink.File);
  if (variant.inputs.inputHash !== cadlink.Sha256) {
    // Base parts or rule code changed since the op was recorded. The truthful geometry is the
    // variant of the CURRENT parts — an exception here would break the whole regenerate
    // composite (its reparent would find no node). The family's `BakedInputHash` then no longer
    // matches, which `web_parametric_inspect` reports as upToDate:false. Not cached under the
    // old key: that key names a different variant.
    console.warn(
      `[parametric] family "${p.FamilyPath}" changed since this variant was recorded (base parts or rule code) `
      + '— replayed with the current parts; regenerate it to refresh the baked hash.',
    );
    return glb;
  }
  // Same weld as `importCad` applies before caching — the cache holds one form.
  await putCadGlb(cadlink.Sha256, cadlink.Quality, glb, 'parametric');
  return glb;
}
