// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// Types of tools/pallet-yard.mjs (plan-612) for the TypeScript tests.

export interface PathGraphEntry {
  id: string;
  segments: Array<Record<string, unknown>>;
  successors: string[];
  zone?: string;
  zoneCapacity?: number;
}

/** The part of a gltf-transform node the tests read. */
export interface GltfNodeLike {
  getName(): string;
  getExtras(): Record<string, any>;
  getTranslation(): number[];
  getRotation(): number[];
  getScale(): number[];
  getWorldMatrix(): number[];
  getMesh(): { listPrimitives(): Array<{
    getAttribute(name: string): { getMin(target: number[]): number[]; getMax(target: number[]): number[] } | null;
  }> } | null;
  listChildren(): GltfNodeLike[];
}
export interface GltfDocumentLike {
  getRoot(): {
    listScenes(): Array<{ getName(): string; getExtras(): Record<string, any>; listChildren(): GltfNodeLike[] }>;
    listNodes(): GltfNodeLike[];
  };
}

export declare const LIBRARY_DIR: string;
export declare const DEFAULT_GLB: string;
export declare const DEFAULT_MANIFEST: string;
export declare const SCENE_NAME: string;
export declare const ROOT_NAME: string;
export declare const PATH_NETWORK_NAME: string;
export declare const DOCUMENT_NAME: string;
export declare const SCRIPT_REF: string;
export declare const DOCUMENT_ID: string;
/** NodeId of PalletYardRoot in the demo document (the address the demo variants use). */
export declare const ROOT_NODE_ID: string;
/** AGV breakdowns of the demo document (Base). */
export declare const DEMO_AGV_DOWNTIME: Readonly<{ mtbf: number; mttr: number; stochastic: boolean }>;
/** The demo experiment's `Variants` block (scene extras). */
export declare const DEMO_VARIANTS: Readonly<{
  version: 1; active: null;
  variants: Array<{ id: string; name: string; revision: number; overrides: Array<{ address: string; component: string; field: string; value: number | boolean | string }> }>;
}>;

export declare function buildPathGraph(): PathGraphEntry[];
/** The `rv_extras.PathBlock` payload of one composed block (plan-628 8.6). */
export declare function pathBlockExtras(b: {
  kind: string; params: Record<string, unknown>; pose: number[]; host?: string; hostPathId?: string; frontPathId?: string;
}): Record<string, unknown>;
/** Translation of a reference node so the asset content stands at (at, rot) — compensates the asset root translation (CP1d-b). */
export declare function compensatedTranslation(assetRoot: GltfNodeLike, at: number[], rot: number[]): number[];
export declare function compensatedPose(assetRoot: GltfNodeLike, at: number[], rot: number[]): { translation: number[]; rotation: number[] };
export declare function readGlb(file: string): Promise<GltfDocumentLike>;
export declare function buildPalletYardBytes(opts?: { preserved?: Record<string, unknown> }): Promise<Uint8Array>;
/** Scene-extras keys a rerun copies from the existing file (plan-630 Phase 3: PlanningScenarios). */
export declare const PRESERVED_SCENE_KEYS: string[];
/** The preserved scene-extras blocks of an existing GLB (`{}` when none). */
export declare function readPreservedSceneExtras(glbPath: string): Record<string, unknown>;
export declare function ensureManifestRow(manifestPath: string, rel: string): boolean;
export declare function writePalletYard(opts?: { glbPath?: string; manifestPath?: string }): Promise<{
  sha256: string; sizeBytes: number; written: boolean; inserted: boolean; rel: string;
}>;
