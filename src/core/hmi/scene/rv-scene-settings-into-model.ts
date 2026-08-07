// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-settings-into-model — write a scene's property overrides INTO the
 * model GLB.
 *
 * A scene's edits normally live in the op log in localStorage; the loader folds
 * them into `userData.realvirtual` as an overlay at load time. That works, but
 * it binds the configuration to one browser profile: a signal link made in the
 * demo scene does not travel with the file.
 *
 * Writing them into the model removes that dependency. Every override that is
 * expressible as node extras is merged into `nodes[i].extras.realvirtual` of the
 * source GLB, so the resulting file loads with the same configuration and an
 * EMPTY op log. That is what a viewer-mode or customer delivery needs: one file,
 * nothing beside it.
 *
 * Three properties are deliberate and load-bearing:
 *
 *  - **The geometry is the original, bit for bit.** Only the JSON chunk is
 *    rewritten (`rv-glb-chunks.ts`); the BIN chunk is copied as an opaque tail.
 *    Nothing is re-encoded, so none of `GLTFExporter`'s losses can occur here.
 *  - **The merge mirrors `applyOverlayToNode` exactly** — per-field assignment,
 *    `null` deletes (RFC 7396), and the component object is created even when it
 *    ends up empty. Any deviation would make the written file behave differently
 *    from the scene the user was just looking at, which is the one outcome worth
 *    preventing.
 *  - **Node identity is verified, not assumed.** The caller resolves paths to
 *    glTF indices from the map captured when the model was LOADED, but the bytes
 *    patched here were fetched separately. `expectedNames` closes that gap — see
 *    {@link ModelSourceChangedError}.
 *
 * Only `setField` / `unsetField` / `setCode` reach the overlay. Placements,
 * added or moved nodes and connections are structural and cannot be expressed
 * as node extras — the caller checks for those BEFORE calling in here (see
 * `SceneStore.saveSettingsIntoModel`).
 */

import { parseGlbChunks, rebuildGlbWithJson, defaultSceneExtras } from '../../persistence/rv-glb-chunks';
import type { RVExtrasOverlay } from '../../engine/rv-extras-overlay-store';

/** Resolves an overlay node path to a glTF `nodes[]` index, or null if unknown. */
export type GltfNodeIndexResolver = (nodePath: string) => number | null;

export interface WriteSettingsOptions {
  /**
   * The raw glTF node names captured when the model was loaded, indexed exactly
   * like `nodes[]`. Used to prove the fetched bytes are still the file the
   * indices were derived from. Omitting it skips the check — only correct when
   * the caller already knows the bytes are the loaded ones.
   */
  expectedNames?: readonly (string | undefined)[];
}

export interface WriteSettingsResult {
  /** The patched GLB. Same BIN chunk as the source. */
  glb: Uint8Array;
  /** Number of glTF nodes that received at least one field. */
  nodes: number;
  /** Number of individual fields written or deleted. */
  fields: number;
  /** True when a now-invalid `rv_sig` was dropped from the default scene extras. */
  signatureDropped: boolean;
}

/**
 * Thrown when an overlay targets a node the GLB does not have.
 *
 * Skipping those quietly would produce a file that looks complete but is
 * missing exactly the links the user configured, with nothing to indicate it.
 * All unresolved paths are collected so one run reports the whole problem.
 */
export class NodeNotFoundError extends Error {
  constructor(public readonly paths: string[]) {
    super(
      `${paths.length} node path(s) from the scene's edits do not exist in the model — ` +
      paths.slice(0, 8).join(', ') + (paths.length > 8 ? `, … (+${paths.length - 8} more)` : ''),
    );
    this.name = 'NodeNotFoundError';
  }
}

/**
 * Thrown when the fetched GLB is not the file the node indices came from.
 *
 * The indices are captured from `gltfParser.associations` at LOAD time, but the
 * bytes patched here are fetched again later. If the URL served something else
 * in between — a redeployed model, a republished CONNECT model, a service
 * worker update — index N now means a different node, and the settings would be
 * written silently onto the wrong machine part. Refusing is the only safe move.
 */
export class ModelSourceChangedError extends Error {
  constructor(public readonly detail: string) {
    super(`The model file changed since it was loaded (${detail}). Reload the model and try again.`);
    this.name = 'ModelSourceChangedError';
  }
}

/**
 * Thrown when an override value cannot survive JSON without changing meaning.
 *
 * `JSON.stringify` turns `NaN` and `±Infinity` into `null` and drops
 * `undefined` — silently. A file that reports success and then loads with a
 * different value than the scene had is worse than a refusal.
 */
export class UnrepresentableValueError extends Error {
  constructor(public readonly locations: string[]) {
    super(
      `${locations.length} setting(s) cannot be stored in a model file — ` +
      locations.slice(0, 8).join('; ') + (locations.length > 8 ? `; … (+${locations.length - 8} more)` : ''),
    );
    this.name = 'UnrepresentableValueError';
  }
}

type GltfNode = { name?: string; extras?: Record<string, unknown> };

/** Recursively describe why a value would not survive `JSON.stringify` intact. */
function unrepresentableReason(value: unknown, seen: Set<object>): string | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? null : `${value} is not a finite number`;
    case 'bigint': return 'BigInt cannot be serialised';
    case 'function': return 'a function cannot be serialised';
    case 'symbol': return 'a symbol cannot be serialised';
    case 'undefined': return 'undefined would be dropped';
    case 'string':
    case 'boolean': return null;
    default: break;
  }
  const obj = value as object;
  if (seen.has(obj)) return 'the value contains a cycle';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const why = unrepresentableReason(obj[i], seen);
        if (why) return `[${i}]: ${why}`;
      }
      return null;
    }
    for (const [key, entry] of Object.entries(obj)) {
      const why = unrepresentableReason(entry, seen);
      if (why) return `.${key}: ${why}`;
    }
    return null;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Merge `overlay` into the source GLB's node extras and return the patched bytes.
 *
 * @param source     the original GLB bytes (never mutated)
 * @param overlay    `materialise(ops).overlay`
 * @param resolveIndex  overlay node path → glTF node index (NodeRegistry-backed)
 */
export function writeSettingsIntoModel(
  source: ArrayBuffer | Uint8Array,
  overlay: RVExtrasOverlay,
  resolveIndex: GltfNodeIndexResolver,
  options: WriteSettingsOptions = {},
): WriteSettingsResult {
  const chunks = parseGlbChunks(source);
  const gltfNodes = chunks.json.nodes as GltfNode[] | undefined;

  // Identity check before anything is written. A node-count mismatch alone is
  // enough to prove the file changed; per-node names catch a same-size edit.
  //
  // An EMPTY array means "nothing was captured", not "the file had no nodes" —
  // treating it as the latter would refuse every model whose load path did not
  // record names, with a message blaming a change that never happened.
  const expected = options.expectedNames?.length ? options.expectedNames : null;
  if (expected && (gltfNodes?.length ?? 0) !== expected.length) {
    throw new ModelSourceChangedError(
      `it now has ${gltfNodes?.length ?? 0} nodes instead of ${expected.length}`,
    );
  }

  const unresolved: string[] = [];
  const unrepresentable: string[] = [];
  const resolved: { node: GltfNode; overrides: Record<string, Record<string, unknown>> }[] = [];

  for (const [nodePath, overrides] of Object.entries(overlay.nodes)) {
    const index = resolveIndex(nodePath);
    const node = index === null ? undefined : gltfNodes?.[index];
    if (!node || index === null) { unresolved.push(nodePath); continue; }

    if (expected && node.name !== expected[index]) {
      throw new ModelSourceChangedError(
        `node ${index} is now "${node.name ?? '<unnamed>'}" instead of "${expected[index] ?? '<unnamed>'}"`,
      );
    }

    for (const [componentType, fields] of Object.entries(overrides)) {
      for (const [fieldName, value] of Object.entries(fields)) {
        const why = unrepresentableReason(value, new Set());
        if (why) unrepresentable.push(`${nodePath} → ${componentType}.${fieldName}${why.startsWith('.') || why.startsWith('[') ? why : `: ${why}`}`);
      }
    }
    resolved.push({ node, overrides });
  }
  if (unresolved.length > 0) throw new NodeNotFoundError(unresolved);
  if (unrepresentable.length > 0) throw new UnrepresentableValueError(unrepresentable);

  let nodes = 0;
  let fields = 0;

  for (const { node, overrides } of resolved) {
    const extras = (node.extras ??= {});
    const rv = (extras.realvirtual ??= {}) as Record<string, Record<string, unknown>>;
    let touched = false;

    for (const [componentType, componentFields] of Object.entries(overrides)) {
      // Created unconditionally — `applyOverlayToNode` does the same, so a
      // component whose every field was deleted stays present in both.
      const target = (rv[componentType] ??= {});
      for (const [fieldName, value] of Object.entries(componentFields)) {
        if (value === null) {
          if (fieldName in target) { delete target[fieldName]; fields++; touched = true; }
        } else {
          target[fieldName] = value;
          fields++;
          touched = true;
        }
      }
    }
    if (touched) nodes++;
  }

  // The signature covers the whole file, so any JSON edit invalidates it.
  // Dropping it is honest; leaving it would make the file report as tampered,
  // which gates all component logic on load. Re-signing, when a delivery needs
  // it, belongs AFTER this step.
  const sceneExtras = defaultSceneExtras(chunks.json);
  const signatureDropped = !!sceneExtras && Object.prototype.hasOwnProperty.call(sceneExtras, 'rv_sig');
  if (signatureDropped) delete sceneExtras!.rv_sig;

  return { glb: rebuildGlbWithJson(chunks), nodes, fields, signatureDropped };
}
