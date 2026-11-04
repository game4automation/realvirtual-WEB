// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Snap-graph helpers shared between behaviors that need to know about their
 * paired outputs (Conveyor → first/only out; Turntable → all outs, picks
 * one to dispatch).
 *
 * The host shape is loose so these are testable without a real RVViewer:
 * just `getPlugin('snap-point') → { getRegistry() → { getByOwnerRoot, getById } }`.
 *
 * plan-633 Phase 2: the registry comes from the ONE connection-core access
 * point `getConnectionRegistry(host)` (snap-point plugin → its live registry;
 * no plugin → the headless registry a DES binding attached), and the port role
 * from the core's `portRoleOf` — the single place the input/output decision is
 * made for planner, DES binding, SDK ports and Turntable alike.
 */

import type { Object3D } from 'three';
import { getConnectionRegistry } from '../../core/connect/rv-connection-registry';
import {
  portRoleOf,
  surfacesFromComponentRegistry,
  type SurfaceComponentRegistry,
  type SurfacesOf,
} from '../../core/connect/rv-connection-resolver';

export interface SnapLite {
  readonly id: string;
  readonly object3D: Object3D;
  readonly flow?: 'in' | 'out' | 'bidi';
  readonly pairedSnapId?: string;
  readonly ownerRoot: Object3D;
}

export interface OutputPairing {
  /** The downstream LayoutObject root paired through `snap`. */
  ownerRoot: Object3D;
  /** This conveyor/turntable's out-flow snap. */
  snap: SnapLite;
  /** The matched downstream snap. */
  pairedSnap: SnapLite;
}

/**
 * A turntable port connection classified by the DIRECTION of the connected
 * conveyor's transport: a conveyor that moves goods toward the turntable is an
 * `input`; one that moves them away is an `output`. Independent of the snap's
 * authored `flow` (works with bidirectional `Snap-?B-*` ports).
 */
export interface PortConnection {
  role: 'input' | 'output';
  /** The connected (conveyor) LayoutObject root. */
  ownerRoot: Object3D;
  /** This turntable's port snap (its `object3D` feeds the angle math). */
  snap: SnapLite;
  /** The matched conveyor-side snap. */
  pairedSnap: SnapLite;
}

interface SnapHost {
  getPlugin?(id: string): unknown;
}

interface ClassifyHost extends SnapHost {
  registry?: unknown;
}

interface SnapRegistryShape {
  getByOwnerRoot(r: Object3D): readonly SnapLite[];
  getById(id: string): SnapLite | undefined;
}

function getRegistry(host: SnapHost): SnapRegistryShape | null {
  return getConnectionRegistry(host) as unknown as SnapRegistryShape | null;
}

/**
 * All snaps registered on `root` (paired or not). Empty when the snap-point
 * plugin isn't available yet (e.g. before the scene scan, or in minimal tests).
 */
export function listOwnSnaps(host: SnapHost, root: Object3D): SnapLite[] {
  const reg = getRegistry(host);
  return reg ? [...reg.getByOwnerRoot(root)] : [];
}

/**
 * Every paired output snap on `root`: for each `flow === 'out'` snap with a
 * `pairedSnapId`, resolve its partner and the partner's owner. Self-loops and
 * unpaired/missing partners are filtered out.
 */
export function findOutputPairings(host: SnapHost, root: Object3D): OutputPairing[] {
  const reg = getRegistry(host);
  if (!reg) return [];
  const out: OutputPairing[] = [];
  for (const sp of reg.getByOwnerRoot(root)) {
    if (sp.flow !== 'out' || !sp.pairedSnapId) continue;
    const partner = reg.getById(sp.pairedSnapId);
    if (!partner || partner.ownerRoot === root) continue;
    out.push({ ownerRoot: partner.ownerRoot, snap: sp, pairedSnap: partner });
  }
  return out;
}

/**
 * First paired-output owner — the single-successor convenience used by
 * Conveyor. Returns null when no paired out-flow snap exists.
 */
export function findDownstreamRoot(host: SnapHost, root: Object3D): Object3D | null {
  const all = findOutputPairings(host, root);
  return all.length > 0 ? all[0].ownerRoot : null;
}

/**
 * First (or only) input snap node on `root`: any `flow === 'in'` snap.
 * Returns the underlying Object3D for angle-math computations (its local
 * position relative to `root` defines the input direction). null if absent.
 */
export function findInputSnapNode(host: SnapHost, root: Object3D): Object3D | null {
  const reg = getRegistry(host);
  if (!reg) return null;
  for (const sp of reg.getByOwnerRoot(root)) {
    if (sp.flow === 'in') return sp.object3D;
  }
  return null;
}

/** Read the component registry off the host (RVViewer), or null in tests/minimal hosts. */
export function getComponentRegistry(host: ClassifyHost): SurfaceComponentRegistry | null {
  const reg = host.registry as Partial<SurfaceComponentRegistry> | undefined | null;
  return reg && typeof reg.findInChildren === 'function'
    ? (reg as SurfaceComponentRegistry)
    : null;
}

/**
 * Classify every PAIRED snap on `root` as an input or output port, based on the
 * direction the connected conveyor transports goods relative to this turntable.
 *
 * The decision itself is the connection core's `portRoleOf` (plan-633): the
 * authored flow, refined by the partner's most aligned transport surface — a
 * belt moving TOWARD `root` feeds it (`input`), one moving AWAY is fed by it
 * (`output`). Without a component registry (no surfaces) or with a ~0
 * projection the authored `flow` decides (legacy behaviour).
 *
 * `surfaces` (additive, plan-644): a caller-supplied surface source — `null`
 * means "no surfaces" (authored flow only); omitted, the surfaces come from
 * the host's component registry as before. The DES port cache
 * (`resolvePorts` with a `PortResolveCacheScope`) passes its memoised source
 * so a hot call does not traverse the partner subtree again.
 */
export function classifyConnections(
  host: ClassifyHost,
  root: Object3D,
  surfaces?: SurfacesOf | null,
): PortConnection[] {
  const reg = getRegistry(host);
  if (!reg) return [];
  let surfacesOf: SurfacesOf | undefined;
  if (surfaces === undefined) {
    const compReg = getComponentRegistry(host);
    surfacesOf = compReg ? surfacesFromComponentRegistry(compReg) : undefined;
  } else {
    surfacesOf = surfaces ?? undefined;
  }
  const out: PortConnection[] = [];

  for (const sp of reg.getByOwnerRoot(root)) {
    if (!sp.pairedSnapId) continue;
    const partner = reg.getById(sp.pairedSnapId);
    if (!partner || partner.ownerRoot === root) continue;
    const role = portRoleOf(root, sp, partner, surfacesOf);
    out.push({ role, ownerRoot: partner.ownerRoot, snap: sp, pairedSnap: partner });
  }
  return out;
}
