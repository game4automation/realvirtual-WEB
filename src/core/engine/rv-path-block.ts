// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-block.ts — the `PathBlock` component (plan-628 P2, §2.3).
 *
 * A placed path-network building block is an empty node `PN_Block_<n>` under
 * `PathNetwork` that carries `rv_extras.PathBlock` (kind, params, pose, host)
 * and has its ordinary `Path` nodes as children. The node transform stays the
 * identity — segments are absolute (B1); the pose is DATA, and moving a block
 * rewrites its segments (`moveBlock` in rv-path-network-ops.ts).
 *
 * WEB-only, like `ParametricComponent`: Unity has no counterpart and ignores
 * the entry on import (unknown component); the paths underneath stay valid,
 * so a viewer without `PathBlock` knowledge still drives the network.
 *
 * Registered WITHOUT a create-factory (precedents `Group`, `NodeKnowledge`):
 * the block is pure data — no live instance, nothing in the tick. Reads go
 * through {@link readPathBlock}, which defaults for itself.
 */

import type { Object3D } from 'three';
import { loadSchemaFromSpec, registerComponentSchema } from './rv-component-registry';
import {
  JUNCTION_KINDS,
  placedTemplate,
  resolveBlockParams,
  type BlockPiece,
  type BlockPose,
  type PathBlockKind,
  type PathBlockSpec,
} from './rv-path-blocks';

/** rv_extras key of the component. */
export const PATH_BLOCK_TYPE = 'PathBlock';

/** Current schema version of the payload. */
export const PATH_BLOCK_VERSION = 1;

/** Name of the ordering node all blocks live under (plan §2.3). */
export const PATH_NETWORK_NODE = 'PathNetwork';

/** The `rv_extras.PathBlock` payload. */
export interface PathBlockExtras {
  type: 'PathBlock';
  version: number;
  kind: PathBlockKind;
  /** Block parameters (everything of {@link PathBlockSpec} except `kind`). */
  params: Omit<PathBlockSpec, 'kind'>;
  /** `[x, z, headingDeg]` — origin = input port (straight/curve) or the node on the host (junctions). */
  pose: BlockPose;
  /** Elevation (y, meters) of the block — templates are flat (plan-628 decision 2026-10-21). */
  y?: number;
  /** Junction block: node name of the host block ('' = block-free host path). */
  host?: string;
  /** Junction block: id of the host piece AFTER the node (carries the original id, P7). */
  hostPathId?: string;
  /** Junction block: id of the host piece BEFORE the node (`P_front`, P7). */
  frontPathId?: string;
}

const KINDS: ReadonlySet<string> = new Set(['straight', 'curve', 'diverge', 'merge', 'stub']);

function finite(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Defensive parse of a raw `rv_extras.PathBlock` payload. Null when the
 * payload is not an object or names an unknown kind.
 */
export function parsePathBlockExtras(raw: unknown): PathBlockExtras | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== undefined && r.type !== PATH_BLOCK_TYPE) return null;
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null;
  const kind = r.kind as PathBlockKind;
  const rawParams = r.params && typeof r.params === 'object' && !Array.isArray(r.params)
    ? (r.params as Record<string, unknown>) : {};
  const params: Omit<PathBlockSpec, 'kind'> = {};
  for (const k of ['lengthM', 'radiusM', 'degrees', 'stubStraightM'] as const) {
    if (rawParams[k] !== undefined && Number.isFinite(Number(rawParams[k]))) params[k] = Number(rawParams[k]);
  }
  if (rawParams.side === 'left' || rawParams.side === 'right') params.side = rawParams.side;
  if (rawParams.twin === true) params.twin = true;
  const p = Array.isArray(r.pose) ? r.pose : [];
  const out: PathBlockExtras = {
    type: PATH_BLOCK_TYPE,
    version: finite(r.version, PATH_BLOCK_VERSION),
    kind,
    params,
    pose: [finite(p[0], 0), finite(p[1], 0), finite(p[2], 0)],
  };
  if (r.y !== undefined && Number.isFinite(Number(r.y))) out.y = Number(r.y);
  if (typeof r.host === 'string') out.host = r.host;
  if (typeof r.hostPathId === 'string' && r.hostPathId) out.hostPathId = r.hostPathId;
  if (typeof r.frontPathId === 'string' && r.frontPathId) out.frontPathId = r.frontPathId;
  return out;
}

/** The `PathBlock` payload of a node, or null. */
export function readPathBlock(node: Pick<Object3D, 'userData'>): PathBlockExtras | null {
  const rv = (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
  return rv ? parsePathBlockExtras(rv[PATH_BLOCK_TYPE]) : null;
}

/** True when the node carries a `PathBlock`. */
export function isPathBlockNode(node: Pick<Object3D, 'userData'>): boolean {
  return readPathBlock(node) !== null;
}

/** True for diverge / merge / stub blocks (set onto a host path). */
export function isJunctionBlock(b: Pick<PathBlockExtras, 'kind'>): boolean {
  return JUNCTION_KINDS.has(b.kind);
}

/**
 * `template(kind, params, pose)` — the pieces the block would have fresh from
 * the catalog (plan P2a: "edited" is derived by comparing with this, never stored).
 */
export function pathBlockTemplate(b: Pick<PathBlockExtras, 'kind' | 'params' | 'pose' | 'y'>): BlockPiece[] {
  return placedTemplate({ kind: b.kind, ...b.params }, b.pose, b.y ?? 0);
}

/** A fresh payload for a block of `spec` at `pose`. */
export function makePathBlockExtras(spec: PathBlockSpec, pose: BlockPose, extra?: Partial<PathBlockExtras>): PathBlockExtras {
  // Keep only the parameters that matter for the kind — stable, minimal JSON.
  const r = resolveBlockParams(spec);
  const keep: Omit<PathBlockSpec, 'kind'> = {};
  if (spec.kind === 'straight') keep.lengthM = r.lengthM;
  if (spec.kind !== 'straight') keep.radiusM = r.radiusM;
  if (spec.kind === 'curve' || spec.kind === 'diverge' || spec.kind === 'merge') keep.degrees = r.degrees;
  if (spec.kind !== 'straight') keep.side = r.side;
  if (spec.kind === 'stub') { keep.stubStraightM = r.stubStraightM; if (r.twin) keep.twin = true; }
  return { type: PATH_BLOCK_TYPE, version: PATH_BLOCK_VERSION, kind: spec.kind, params: keep, pose: [pose[0], pose[1], pose[2]], ...extra };
}

// ─── Self-register (schema + capabilities, no factory) ───────────────────

registerComponentSchema(PATH_BLOCK_TYPE, loadSchemaFromSpec(PATH_BLOCK_TYPE), {
  // Selectable as a unit in the authoring modes (plan §2.4a / D-N4).
  pick: 'select',
  ui: { filter: 'Paths', category: 'transport', badge: '#26a69a' },
  // Created by the path-network commands only, never via "Add Component".
  authorable: false,
});
