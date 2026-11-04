// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-parametric-variant — the placement path of a parametric family
 * (plan-650 Phase 5, §2.6 "Laufzeit-Pfad").
 *
 * `ModelCache` calls this on a FRESHLY decoded tree of the asset (never the
 * shared master) when a placement's `AssetOverrides` ask for family values:
 *
 *   1. {@link resolveParametricVariant} — find each family by NodeId, normalize
 *      the requested values against its schema, compute the `InputHash`. A
 *      family whose hash equals `BakedInputHash` needs nothing; when no family
 *      needs anything the placement IS the base bake (`variantHash: null`).
 *   2. `apply()` — per family that needs it: the CAD-GLB cache under the fixed
 *      triple (InputHash, 'param-v2', 'parametric') first (F15, zero generator
 *      runs), else generator + assembly (and the result is cached). The new
 *      `_Generated` replaces the old one under the family node; `Values` and
 *      `BakedInputHash` are stamped. `_Parts` is left for the pre-bake hook
 *      (`rv-parametric-component.ts`) that removes it from every bake.
 *
 * The generator never runs while the simulation runs (§2.6a): `apply` takes a
 * standstill probe and refuses (`ParametricDeferredError`) instead of running.
 *
 * Loaded by dynamic import only (from `ModelCache`).
 */

import type { Object3D } from 'three';
import {
  PARAMETRIC_COMPONENT_TYPE,
  type ParametricRequest,
  type ParamValue,
} from './rv-parametric-component';
import { buildVariant, childNamed, resolveFamilyInputs, type FamilyInputs } from './rv-parametric-family';
import { canonicalJSON, sha256Hex } from './rv-parametric-hash';
import { getNodeId } from './rv-node-id';
import { disposeSubtree } from './rv-traverse-utils';

/** Fixed quality token of every parametric cache entry (same as the editor path). */
export const PARAMETRIC_CACHE_QUALITY = 'param-v2';

/** Problem code of the scene-wide variant budget (F16). */
export const PROBLEM_VARIANT_BUDGET = 'parametric-variant-budget';

/** The generator would have to run while the simulation runs (§2.6a). */
export class ParametricDeferredError extends Error {
  readonly code = 'parametric-deferred';
  constructor(family: string) {
    super(`parametric family "${family}": the variant must be generated, but the simulation is running — stop it and retry`);
    this.name = 'ParametricDeferredError';
  }
}

/** One family of the request that needs a new `_Generated`. */
export interface VariantFamily {
  node: Object3D;
  inputs: FamilyInputs;
}

export interface PreparedVariant {
  /** Hash of the variant, or null when every family is at its baked values (= base bake). */
  variantHash: string | null;
  /** The families that need a rebuild (empty when `variantHash` is null). */
  families: VariantFamily[];
  /** Families of the request that were not found in the asset (NodeId unknown / no family). */
  missing: string[];
}

export interface ApplyVariantOptions {
  /** Standstill probe — false = the generator must not run now (§2.6a). Default: allowed. */
  canRunGenerator?: () => boolean;
}

export interface ApplyVariantStats {
  generatorRuns: number;
  cacheHits: number;
}

function nodesById(root: Object3D): Map<string, Object3D> {
  const out = new Map<string, Object3D>();
  root.traverse((n) => {
    const id = getNodeId(n);
    if (id && !out.has(id)) out.set(id, n);
  });
  return out;
}

/**
 * Step 1: inputs + `InputHash` of every requested family on `tree`. Throws with
 * a user-facing message on an invalid value (the placement then shows its
 * hole + problem instead of a silently wrong variant).
 */
export async function resolveParametricVariant(
  tree: Object3D,
  requests: readonly ParametricRequest[],
): Promise<PreparedVariant> {
  const byId = nodesById(tree);
  const families: VariantFamily[] = [];
  const missing: string[] = [];
  const keyParts: [string, string][] = [];
  for (const req of requests) {
    const node = byId.get(req.familyNodeId);
    const stored = node?.userData?.realvirtual?.[PARAMETRIC_COMPONENT_TYPE] as Record<string, unknown> | undefined;
    if (!node || !stored) { missing.push(req.familyNodeId); continue; }
    // Partial override values are completed by the asset's stored ones.
    const merged = { ...((stored.Values ?? {}) as Record<string, unknown>), ...req.values };
    let inputs: FamilyInputs;
    try {
      inputs = await resolveFamilyInputs(node, merged);
    } catch (e) {
      throw new Error(`parametric family "${node.name}": ${e instanceof Error ? e.message : String(e)}`);
    }
    if (inputs.inputHash === stored.BakedInputHash && childNamed(node, inputs.family.generatedRootName)) continue;
    families.push({ node, inputs });
    keyParts.push([req.familyNodeId, inputs.inputHash]);
  }
  if (missing.length > 0) {
    console.warn(`[parametric] placement override names ${missing.length} family node(s) the asset does not have: ${missing.join(', ')}`);
  }
  const variantHash = families.length === 0 ? null : (await sha256Hex(canonicalJSON(keyParts))).slice(0, 32);
  return { variantHash, families, missing };
}

/** Replace `_Generated` of one family with `generated` and stamp the values. */
function installGenerated(fam: VariantFamily, generated: Object3D): void {
  const { node, inputs } = fam;
  const name = inputs.family.generatedRootName;
  const old = childNamed(node, name);
  if (old) {
    node.remove(old);
    disposeSubtree(old);
  }
  generated.name = name;
  // The variant's frame is the frame of `PartsRoot` (Phase 3 decision).
  generated.position.copy(inputs.partsRoot.position);
  generated.quaternion.copy(inputs.partsRoot.quaternion);
  generated.scale.copy(inputs.partsRoot.scale);
  node.add(generated);
  const pc = node.userData.realvirtual[PARAMETRIC_COMPONENT_TYPE] as Record<string, unknown>;
  pc.Values = { ...inputs.values } as Record<string, ParamValue>;
  pc.BakedInputHash = inputs.inputHash;
}

/**
 * Step 2: build (or fetch from the CAD-GLB cache) the `_Generated` subtree of
 * every family in `prepared` and install it on the tree. Mutates the tree.
 */
export async function applyParametricVariant(
  prepared: PreparedVariant,
  opts: ApplyVariantOptions = {},
): Promise<ApplyVariantStats> {
  const stats: ApplyVariantStats = { generatorRuns: 0, cacheHits: 0 };
  if (prepared.families.length === 0) return stats;
  const cache = await import('../import/rv-cad-glb-cache');
  for (const fam of prepared.families) {
    const hash = fam.inputs.inputHash;
    const bytes = await cache.getCadGlb(hash, PARAMETRIC_CACHE_QUALITY, 'parametric');
    if (bytes) {
      const { parseGlbSubtree } = await import('./rv-glb-parse');
      installGenerated(fam, await parseGlbSubtree(bytes));
      stats.cacheHits++;
      continue;
    }
    if (opts.canRunGenerator && !opts.canRunGenerator()) throw new ParametricDeferredError(fam.node.name);
    const variant = await buildVariant(fam.node, fam.inputs.values);
    if (!variant.ok) {
      throw new Error(`parametric family "${fam.node.name}" (${variant.error.code}): ${variant.error.message}`);
    }
    stats.generatorRuns++;
    // Cache in the editor's form (welded GLB) — best effort, a 'none' tier just means the next
    // cold open runs the generator again (never a dead node).
    try {
      const [{ objectToGlb }, { weldImportedGlb }] = await Promise.all([
        import('../import/rv-import-object'), import('../import/rv-glb-weld'),
      ]);
      const glb = weldImportedGlb(await objectToGlb(variant.root), `${fam.node.name}.parametric`);
      await cache.putCadGlb(hash, PARAMETRIC_CACHE_QUALITY, glb, 'parametric');
    } catch (e) {
      console.warn(`[parametric] caching the variant of "${fam.node.name}" failed (next open regenerates):`, e);
    }
    installGenerated(fam, variant.root);
  }
  return stats;
}
