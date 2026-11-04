// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-parametric-family — one family node → one variant (plan-650 Phase 4).
 *
 * The pipeline every entry point shares (asset editor, MCP, the cache-miss
 * rebuild of a draft replay):
 *
 *   family node (`ParametricComponent`) → parse → normalize values
 *     → base parts under `PartsRoot` → `InputHash`
 *     → `runGenerator` (QuickJS, pure function) → `assemble` (duplicate / stretch / bend / place)
 *     → a detached `_Generated` subtree.
 *
 * Nothing here mutates the document or the scene. The editor op layer
 * (`rv-parametric-regenerate.ts`) turns the subtree into ONE undo step; the
 * runtime placement path (Phase 5) will use the same {@link buildVariant}.
 *
 * Also home of the standstill guard {@link canRegenerate} (§2.6a): the
 * generator never runs while the simulation runs.
 *
 * Loaded by dynamic import only (it pulls three.js geometry code and, on first
 * run, QuickJS) — never from the entry bundle.
 */

import type { Object3D } from 'three';
import {
  DEFAULT_GENERATED_ROOT,
  DEFAULT_PARTS_ROOT,
  PARAMETRIC_API_VERSION,
  PARAMETRIC_COMPONENT_TYPE,
  normalizeValues,
  parseParametricComponent,
  type ParametricComponentExtras,
  type ParamValue,
} from './rv-parametric-component';
import { runGenerator, type BuildPlan, type GeneratorLimits, type GeneratorStats } from './rv-parametric-generator';
import { assemble, collectParts, partHashEntries, type AssemblyStats, type ParametricPart } from './rv-parametric-assembly';
import { computeCodeHash, computeInputHash, computePartsHash } from './rv-parametric-hash';
import { identityIdOf } from './rv-decode-identity';

// ─── Lookup ──────────────────────────────────────────────────────────────

/** A family node with its validated extras. */
export interface ParametricFamily {
  node: Object3D;
  extras: ParametricComponentExtras;
  partsRootName: string;
  generatedRootName: string;
}

/** The raw `ParametricComponent` extras of a node, or undefined. */
export function rawParametricExtras(node: Object3D): unknown {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  return rv?.[PARAMETRIC_COMPONENT_TYPE];
}

/** Parse the family on `node`; throws an Error listing every validation problem. */
export function readFamily(node: Object3D): ParametricFamily {
  const raw = rawParametricExtras(node);
  if (raw === undefined) throw new Error(`"${node.name}" carries no ${PARAMETRIC_COMPONENT_TYPE}`);
  const parsed = parseParametricComponent(raw);
  if (!parsed.ok) throw new Error(`${PARAMETRIC_COMPONENT_TYPE} on "${node.name}" is invalid: ${parsed.errors.join('; ')}`);
  return {
    node,
    extras: parsed.value,
    partsRootName: parsed.value.PartsRoot ?? DEFAULT_PARTS_ROOT,
    generatedRootName: parsed.value.GeneratedRoot ?? DEFAULT_GENERATED_ROOT,
  };
}

/** The direct child named `name`, or null. */
export function childNamed(node: Object3D, name: string): Object3D | null {
  return node.children.find((c) => c.name === name) ?? null;
}

/**
 * The family whose GENERATED subtree contains `node` (the node itself or an
 * ancestor below the family), or null. Used by the manual-attach guard (F10).
 */
export function familyOwningGenerated(node: Object3D): ParametricFamily | null {
  let child: Object3D = node;
  let parent = node.parent;
  while (parent) {
    if (rawParametricExtras(parent) !== undefined) {
      try {
        const fam = readFamily(parent);
        if (child.name === fam.generatedRootName) return fam;
      } catch { /* an invalid family owns nothing */ }
    }
    child = parent;
    parent = parent.parent;
  }
  return null;
}

// ─── Hash ────────────────────────────────────────────────────────────────

export interface FamilyInputs {
  family: ParametricFamily;
  partsRoot: Object3D;
  parts: ParametricPart[];
  values: Record<string, ParamValue>;
  codeHash: string;
  inputHash: string;
}

/** Normalized values + base parts + `InputHash` (§2.3). Throws on an invalid value or a missing `PartsRoot`. */
export async function resolveFamilyInputs(
  node: Object3D,
  values?: Readonly<Record<string, unknown>>,
): Promise<FamilyInputs> {
  const family = readFamily(node);
  const partsRoot = childNamed(node, family.partsRootName);
  if (!partsRoot) throw new Error(`family "${node.name}" has no "${family.partsRootName}" child with the base parts`);
  const normalized = normalizeValues(family.extras.Params, values ?? family.extras.Values);
  const parts = collectParts(partsRoot);
  const partsHash = await computePartsHash(await partHashEntries(parts));
  // The stored CodeHash is display data; the key hashes the code that actually runs.
  const codeHash = await computeCodeHash(family.extras.Code);
  const inputHash = await computeInputHash({
    ApiVersion: PARAMETRIC_API_VERSION, CodeHash: codeHash, Values: normalized, PartsHash: partsHash,
    Uses: (family.extras.Uses ?? []).map((u) => [u.Family, u.DocHash] as const),
    // plan-2216: stamped generated NodeIds depend on the family identity.
    ...(identityIdOf(node) ? { FamilyId: identityIdOf(node) as string } : {}),
  });
  return { family, partsRoot, parts, values: normalized, codeHash, inputHash };
}

// ─── Build ───────────────────────────────────────────────────────────────

export type VariantErrorStage = 'input' | 'generator' | 'assembly';

export interface VariantError {
  stage: VariantErrorStage;
  code: string;
  message: string;
}

export interface VariantOk {
  ok: true;
  inputs: FamilyInputs;
  plan: BuildPlan;
  /** Detached `_Generated` subtree (local transform = `PartsRoot`'s). */
  root: Object3D;
  generatorStats: GeneratorStats;
  assemblyStats: AssemblyStats;
  messages: { level: 'info' | 'warning'; text: string }[];
  /** Wall time of generator + assembly in ms (display only, never asserted). */
  elapsedMs: number;
}

export type VariantResult = VariantOk | { ok: false; error: VariantError; inputs?: FamilyInputs };

/**
 * Generate + assemble the variant of the family on `node` for `values`
 * (default: the stored `Values`). Throw-free.
 */
export async function buildVariant(
  node: Object3D,
  values?: Readonly<Record<string, unknown>>,
  limits?: Partial<GeneratorLimits>,
): Promise<VariantResult> {
  let inputs: FamilyInputs;
  try {
    inputs = await resolveFamilyInputs(node, values);
  } catch (e) {
    return { ok: false, error: { stage: 'input', code: 'invalid-input', message: e instanceof Error ? e.message : String(e) } };
  }
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const gen = await runGenerator(inputs.family.extras.Code, inputs.values, inputs.parts.map((p) => p.info), limits);
  if (!gen.ok) return { ok: false, error: { stage: 'generator', code: gen.error.code, message: gen.error.message }, inputs };
  const asm = assemble(inputs.partsRoot, gen.plan, {
    generatedName: inputs.family.generatedRootName, parts: inputs.parts,
    uses: inputs.family.extras.Uses ?? [],
    // plan-769 F12: the family node's identity (authored NodeId or decode seed).
    childIdPrefix: identityIdOf(node) ?? node.name,
    familyId: identityIdOf(node) ?? null,
  });
  if (!asm.ok) return { ok: false, error: { stage: 'assembly', code: asm.error.code, message: asm.error.message }, inputs };
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    ok: true, inputs, plan: gen.plan, root: asm.root,
    generatorStats: gen.stats, assemblyStats: asm.stats, messages: asm.messages,
    elapsedMs: Math.round((t1 - t0) * 10) / 10,
  };
}

// ─── Standstill guard (§2.6a) ────────────────────────────────────────────

// Lives in the (entry-loaded) component module since Phase 5 — the placement
// instancer needs it synchronously; re-exported here for the editor path.
export { canRegenerate, type StandstillView } from './rv-parametric-component';
