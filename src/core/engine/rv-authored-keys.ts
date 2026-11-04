// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-authored-keys — the runtime `userData` keys that carry what a node was
 * AUTHORED as, next to what the loader made of it (plan-769 Phase 1).
 *
 * One module, no imports: the parse (`rv-glb-parse.ts`, which drags the
 * GLTFLoader in), the bake pipeline, composition and the decode identity all
 * need the same spellings, and three private copies of `'_rvOrigName'` were how
 * they drifted before.
 *
 * Every key starts with `_`: `sanitizeUserDataForExport` strips exactly those
 * on save, so none of them ever reaches a written file. `Object3D.copy` /
 * `cloneLogicNode` JSON-copy `userData`, so all of them travel with every clone
 * and placement instance.
 */

/**
 * A node's RAW glTF name when the loader had to rename it (genuine `_N` dedup,
 * plan-734) — written by `detectRenamedNodes`, read by `collectRenamedNodes`.
 */
export const RV_ORIG_NAME_KEY = '_rvOrigName';

/**
 * The NodeId SEEDED for a node that arrived without one (plan-769 F2/D3):
 * `UUIDv5(rv namespace, canonical authored path)`, stamped by
 * `rv-decode-identity.ts` at every decode. Runtime only — Phase 1 persists no
 * id (F17); the Phase-3 writer promotes it to `realvirtual.NodeId` on save. A
 * node with an authored `realvirtual.NodeId` never carries this key (its file
 * id wins), and a value that leaked into a file through a writer without the
 * sanitizer is overwritten at the next decode.
 */
export const RV_SEEDED_NODE_ID_KEY = '_rvNodeId';
