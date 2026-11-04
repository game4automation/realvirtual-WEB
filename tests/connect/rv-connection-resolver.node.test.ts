// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connection-resolver.node.test.ts — plan-633 §9.1 (Phase 1, unit).
 *
 * The public connection core in isolation: snap stage (pairing through the
 * headless connection registry), port roles from the injected transport
 * surfaces, the conflict rule for double outputs, the typed distance fallback
 * (cases ported from the private `logical-connections.test.ts`), the legacy
 * radius / OUT→IN metric, `contained`, determinism under shuffled input, the
 * registry access point and the shared path-link tolerance.
 *
 * Public only — no private imports (the core must stay testable in the
 * community build).
 */

import { describe, it, expect } from 'vitest';
import { Mesh, BoxGeometry, Object3D, Quaternion, Vector3 } from 'three';
import {
  resolveConnections,
  resolveConnectionsDetailed,
  portRoleOf,
  type Connectable,
  type ConnectionLink,
  type SurfacesOf,
  type TransportSurfaceLike,
} from '../../src/core/connect/rv-connection-resolver';
import {
  acquireBindingConnectionRegistry,
  attachHeadlessConnectionRegistry,
  buildConnectionRegistry,
  detachHeadlessConnectionRegistry,
  getConnectionRegistry,
  hasSnapPointPlugin,
} from '../../src/core/connect/rv-connection-registry';
import { SNAP_PAIR_EPS_M } from '../../src/core/connect/snap-pairing';
import * as pluginParser from '../../src/plugins/snap-point/snap-name-parser';
import * as coreParser from '../../src/core/connect/snap-name-parser';
import * as pluginScanner from '../../src/plugins/snap-point/snap-scanner';
import * as coreScanner from '../../src/core/connect/snap-scanner';
import * as pluginPairing from '../../src/plugins/snap-point/snap-pairing-rebuild';
import * as corePairing from '../../src/core/connect/snap-pairing';
import { SnapPointRegistry } from '../../src/core/engine/rv-snap-point-registry';
import {
  PATH_LINK_TOLERANCE,
  isPathLink,
  tangentAngleDeg,
} from '../../src/core/connect/path-link-tolerance';
import { parsePathExtras, getPathEndpoints } from '../../src/core/engine/rv-path';

// ─── Builders ───────────────────────────────────────────────────────────────

let uuidSeq = 0;
/** Deterministic uuids so tie-breaks are testable; `id` overrides. */
function node(name: string, id?: string): Object3D {
  const n = new Object3D();
  n.name = name;
  n.uuid = id ?? `u-${String(uuidSeq++).padStart(6, '0')}`;
  return n;
}

function addSnap(parent: Object3D, name: string, x: number, y = 0, z = 0): Object3D {
  const s = node(name);
  s.position.set(x, y, z);
  parent.add(s);
  return s;
}

/** Instance root at (x,0,z) with optional snaps (local x positions). */
function root(name: string, x: number, z = 0, id?: string): Object3D {
  const r = node(name, id);
  r.position.set(x, 0, z);
  return r;
}

function conveyorRoot(name: string, x: number, z = 0, id?: string): Object3D {
  const r = root(name, x, z, id);
  addSnap(r, 'Snap-XN-convroll', -0.5);
  addSnap(r, 'Snap-XP-convroll', +0.5);
  return r;
}

function c(rootNode: Object3D, kind: string, extra: Partial<Connectable> = {}): Connectable {
  return { root: rootNode, kind, connectionType: 'material-flow', ...extra };
}

function refresh(...roots: Object3D[]): void {
  for (const r of roots) r.updateWorldMatrix(true, true);
}

/** Ordered successor names per `from` (independent of global list order). */
function successors(links: readonly ConnectionLink[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const l of links) (out[l.from.name] ??= []).push(l.to.name);
  return out;
}

function edgeNames(links: readonly ConnectionLink[]): string[] {
  return links.map((l) => `${l.from.name}>${l.to.name}:${l.via}`);
}

/** surfacesOf from a map root → world travel directions (scene order). */
function surfaces(map: Map<Object3D, Vector3[]>): SurfacesOf {
  return (r) => (map.get(r) ?? []).map((d): TransportSurfaceLike => ({
    getWorldDirection: (out = new Vector3()) => out.copy(d),
  }));
}

/** Fisher–Yates with a fixed LCG — deterministic shuffle. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── F2: moved helpers, re-exported unchanged ───────────────────────────────

describe('F2 — snap helpers live in core/connect, plugin paths re-export them', () => {
  it('the plugin modules expose the very same functions', () => {
    expect(pluginParser.parseSnapName).toBe(coreParser.parseSnapName);
    expect(pluginParser.flowsCompatible).toBe(coreParser.flowsCompatible);
    expect(pluginParser.forcesBidiPort).toBe(coreParser.forcesBidiPort);
    expect(pluginScanner.scanAndRegisterSnaps).toBe(coreScanner.scanAndRegisterSnaps);
    expect(pluginPairing.computeProximityPairings).toBe(corePairing.computeProximityPairings);
  });

  it('one pairing epsilon, owned by the core (30 mm; the planner re-exports it)', () => {
    expect(SNAP_PAIR_EPS_M).toBe(0.03);
  });
});

// ─── Snap stage ─────────────────────────────────────────────────────────────

describe('snap stage — pairing through the headless connection registry', () => {
  it('pairs typeId-equal, flow-compatible snaps of different owners → one snap link', () => {
    const a = conveyorRoot('A', 0);
    const b = conveyorRoot('B', 1);
    refresh(a, b);
    const reg = buildConnectionRegistry([a, b]);
    const links = resolveConnections([c(a, 'conveyor'), c(b, 'conveyor')], { registry: reg, distanceFallback: false });
    expect(edgeNames(links)).toEqual(['A>B:snap']);
    const l = links[0];
    expect(l.contained).toBe(false);
    expect(l.distance).toBeCloseTo(0, 9);
    expect(l.snapIds).toBeDefined();
    expect(reg.getById(l.snapIds![0])!.ownerRoot).toBe(a);
    expect(reg.getById(l.snapIds![1])!.ownerRoot).toBe(b);
  });

  it('different typeId never pairs', () => {
    const a = root('A', 0); addSnap(a, 'Snap-XP-convroll', 0.5);
    const b = root('B', 1); addSnap(b, 'Snap-XN-chain', -0.5);
    refresh(a, b);
    const reg = buildConnectionRegistry([a, b]);
    expect(resolveConnections([c(a, 'conveyor'), c(b, 'conveyor')], { registry: reg, distanceFallback: false })).toEqual([]);
  });

  it('out ↔ out never pairs (flow clash)', () => {
    const a = root('A', 0); addSnap(a, 'Snap-XP-convroll', 0.5);
    const b = root('B', 1); addSnap(b, 'Snap-XP-convroll', -0.5);
    refresh(a, b);
    const reg = buildConnectionRegistry([a, b]);
    expect(resolveConnections([c(a, 'conveyor'), c(b, 'conveyor')], { registry: reg, distanceFallback: false })).toEqual([]);
  });

  it('30 mm pairing window: 29 mm pairs, 31 mm does not', () => {
    for (const [gap, expected] of [[0.029, 1], [0.031, 0]] as const) {
      const a = conveyorRoot('A', 0);
      const b = conveyorRoot('B', 1 + gap);
      refresh(a, b);
      const reg = buildConnectionRegistry([a, b]);
      const links = resolveConnections([c(a, 'conveyor'), c(b, 'conveyor')], { registry: reg, distanceFallback: false });
      expect(links, `gap ${gap}`).toHaveLength(expected);
    }
  });

  it('own snaps never pair, even when coincident', () => {
    const a = root('A', 0);
    addSnap(a, 'Snap-XP-convroll', 0.5);
    addSnap(a, 'Snap-XN-convroll', 0.5);
    refresh(a);
    const reg = buildConnectionRegistry([a]);
    expect(reg.getAll().every((s) => !s.pairedSnapId)).toBe(true);
    expect(resolveConnections([c(a, 'conveyor')], { registry: reg, distanceFallback: false })).toEqual([]);
  });

  it('a partner outside the connectable set is ignored (no link to an unbound node)', () => {
    const a = conveyorRoot('A', 0);
    const b = conveyorRoot('B', 1);
    refresh(a, b);
    const reg = buildConnectionRegistry([a, b]);
    expect(resolveConnections([c(a, 'conveyor')], { registry: reg, distanceFallback: false })).toEqual([]);
  });

  it('determinism: shuffled connectables give the same per-from successor lists', () => {
    const roots = [conveyorRoot('A', 0), conveyorRoot('B', 1), conveyorRoot('C', 2), conveyorRoot('D', 3)];
    const src = root('S', -0.75); addSnap(src, 'Snap-XP-convroll', 0.25);
    const snk = root('K', 3.75); addSnap(snk, 'Snap-XN-convroll', -0.25);
    const all = [src, ...roots, snk];
    refresh(...all);
    const conns = [c(src, 'source'), ...roots.map((r) => c(r, 'conveyor')), c(snk, 'sink')];
    const reg = buildConnectionRegistry(all);
    const ref = successors(resolveConnections(conns, { registry: reg }));
    expect(ref).toEqual({ S: ['A'], A: ['B'], B: ['C'], C: ['D'], D: ['K'] });
    for (const seed of [1, 7, 42, 1234]) {
      // Same registry, shuffled connectables …
      expect(successors(resolveConnections(shuffled(conns, seed), { registry: reg }))).toEqual(ref);
      // … and a registry built from shuffled owners (unambiguous geometry).
      const reg2 = buildConnectionRegistry(shuffled(all, seed));
      expect(successors(resolveConnections(shuffled(conns, seed + 1), { registry: reg2 }))).toEqual(ref);
    }
  });

  it('output order = wiring order: snap links grouped by from in input order, then distance links', () => {
    const a = conveyorRoot('A', 0);
    const b = conveyorRoot('B', 1);
    const lone = root('Lone', 5); // no snaps → distance stage
    const near = root('Near', 5.4);
    refresh(a, b, lone, near);
    const reg = buildConnectionRegistry([a, b, lone, near]);
    const links = resolveConnections(
      [c(b, 'conveyor'), c(lone, 'source'), c(a, 'conveyor'), c(near, 'sink')],
      { registry: reg },
    );
    // B has no paired output (its XP snap is free) → distance; A → B is the snap link.
    expect(links.map((l) => l.via)).toEqual(['snap', ...links.slice(1).map(() => 'distance')]);
    expect(links[0].from.name).toBe('A');
  });
});

// ─── Roles ──────────────────────────────────────────────────────────────────

/** Turntable at the origin with four bidi ports (forced by the asset name). */
function turntableRoot(id?: string): Object3D {
  const tt = root('Turntable', 0, 0, id);
  addSnap(tt, 'Snap-XN-convroll', -0.5);
  addSnap(tt, 'Snap-XP-convroll', +0.5);
  addSnap(tt, 'Snap-ZN-convroll', 0, 0, -0.5);
  addSnap(tt, 'Snap-ZP-convroll', 0, 0, +0.5);
  return tt;
}

describe('roles — one place (portRoleOf), refined by the partner surfaces', () => {
  it('Conveyor ↔ Turntable yields exactly ONE directed edge per connection', () => {
    const tt = turntableRoot();
    const infeed = conveyorRoot('Infeed', -1);
    const outfeed = conveyorRoot('Outfeed', 1);
    refresh(tt, infeed, outfeed);
    const reg = buildConnectionRegistry([infeed, tt, outfeed]);
    const surf = surfaces(new Map([
      [infeed, [new Vector3(1, 0, 0)]],
      [outfeed, [new Vector3(1, 0, 0)]],
      [tt, [new Vector3(1, 0, 0)]],
    ]));
    const r = resolveConnectionsDetailed(
      [c(infeed, 'conveyor'), c(tt, 'router'), c(outfeed, 'conveyor')],
      { registry: reg, surfacesOf: surf, distanceFallback: false },
    );
    expect(edgeNames(r.links).sort()).toEqual(['Infeed>Turntable:snap', 'Turntable>Outfeed:snap']);
    expect(r.conflictsResolved).toBe(0);
  });

  it('ChainTransfer with orthogonal surfaces: the aligned one decides (cross chain ignored)', () => {
    const tt = turntableRoot();
    const ct = root('ChainTransfer', -1);
    addSnap(ct, 'Snap-XP-convroll', 0.5);
    refresh(tt, ct);
    const reg = buildConnectionRegistry([ct, tt]);
    // Cross chain FIRST (perpendicular, projection 0), roller line second (+X → toward the table).
    const surf = surfaces(new Map([[ct, [new Vector3(0, 0, 1), new Vector3(1, 0, 0)]]]));
    const ttSnap = reg.getByOwnerRoot(tt).find((s) => s.pairedSnapId)!;
    const ctSnap = reg.getById(ttSnap.pairedSnapId!)!;
    expect(portRoleOf(tt, ttSnap, ctSnap, surf)).toBe('input');
    const links = resolveConnections([c(ct, 'router'), c(tt, 'router')], { registry: reg, surfacesOf: surf, distanceFallback: false });
    expect(edgeNames(links)).toEqual(['ChainTransfer>Turntable:snap']);
  });

  it('off-centre pivot: the reference is the OWNER origin, not the partner origin', () => {
    const tt = turntableRoot();
    // Outfeed whose pivot sits between the mating point and the table — an
    // origin-based reference on the partner would flip the sign.
    const outfeed = root('Outfeed', 0.6);
    addSnap(outfeed, 'Snap-XN-convroll', -0.1); // world x = 0.5 (table port +X)
    refresh(tt, outfeed);
    const reg = buildConnectionRegistry([tt, outfeed]);
    const surf = surfaces(new Map([[outfeed, [new Vector3(1, 0, 0)]]])); // moves away from the table
    const ttSnap = reg.getByOwnerRoot(tt).find((s) => s.pairedSnapId)!;
    expect(portRoleOf(tt, ttSnap, reg.getById(ttSnap.pairedSnapId!)!, surf)).toBe('output');
  });

  it('without surfaces the authored flow decides (bidi → output, in → input)', () => {
    const tt = turntableRoot();
    const infeed = conveyorRoot('Infeed', -1);
    refresh(tt, infeed);
    const reg = buildConnectionRegistry([infeed, tt]);
    const ttSnap = reg.getByOwnerRoot(tt).find((s) => s.pairedSnapId)!;
    const inSnap = reg.getById(ttSnap.pairedSnapId!)!;
    expect(ttSnap.flow).toBe('bidi');
    expect(portRoleOf(tt, ttSnap, inSnap)).toBe('output');
    expect(portRoleOf(infeed, inSnap, ttSnap)).toBe('output'); // Snap-XP = out
  });

  it('contradicting roles (both ends output): tie keeps the direction from the SMALLER uuid', () => {
    // Table belt moving −X makes the outfeed read the table as its OUTPUT while
    // the table reads the outfeed as its output too (the R2-3 counter-example).
    const tt = turntableRoot('t-b');
    const outfeed = conveyorRoot('Outfeed', 1, 0, 't-a');
    refresh(tt, outfeed);
    const reg = buildConnectionRegistry([tt, outfeed]);
    const surf = surfaces(new Map([
      [outfeed, [new Vector3(1, 0, 0)]],
      [tt, [new Vector3(-1, 0, 0)]],
    ]));
    const r = resolveConnectionsDetailed([c(tt, 'router'), c(outfeed, 'conveyor')], { registry: reg, surfacesOf: surf, distanceFallback: false });
    expect(r.conflictsResolved).toBe(1);
    // Both out-degree 1 → tie → keep from the smaller uuid ('t-a' = Outfeed).
    expect(edgeNames(r.links)).toEqual(['Outfeed>Turntable:snap']);
  });

  it('contradicting roles: the over-subscribed endpoint loses the edge', () => {
    const tt = turntableRoot('t-a');
    const outfeed = conveyorRoot('Outfeed', 1, 0, 't-b');
    const sink = root('Sink', 1.75, 0, 't-c');
    addSnap(sink, 'Snap-XN-convroll', -0.25);
    refresh(tt, outfeed, sink);
    const reg = buildConnectionRegistry([tt, outfeed, sink]);
    const surf = surfaces(new Map([
      [outfeed, [new Vector3(1, 0, 0)]],
      [tt, [new Vector3(-1, 0, 0)]],
    ]));
    const r = resolveConnectionsDetailed(
      [c(tt, 'router'), c(outfeed, 'conveyor'), c(sink, 'sink')],
      { registry: reg, surfacesOf: surf, distanceFallback: false },
    );
    expect(r.conflictsResolved).toBe(1);
    // Outfeed had 2 outputs (Turntable + Sink), the table 1 → Outfeed→Turntable dropped.
    expect(successors(r.links)).toEqual({ Turntable: ['Outfeed'], Outfeed: ['Sink'] });
  });

  it('both ends input → no link (as the DES binding always behaved)', () => {
    const a = root('A', 0); addSnap(a, 'Snap-XB-convroll', 0.5);
    const b = root('B', 1); addSnap(b, 'Snap-XB-convroll', -0.5);
    refresh(a, b);
    const reg = buildConnectionRegistry([a, b]);
    // Each side sees the partner's belt moving toward itself → both 'input'.
    const surf = surfaces(new Map([[a, [new Vector3(1, 0, 0)]], [b, [new Vector3(-1, 0, 0)]]]));
    const r = resolveConnectionsDetailed([c(a, 'conveyor'), c(b, 'conveyor')], { registry: reg, surfacesOf: surf, distanceFallback: false });
    expect(r.links).toEqual([]);
    expect(r.conflictsResolved).toBe(0);
  });
});

// ─── Distance stage (ported from logical-connections.test.ts) ──────────────

function inst(name: string, kind: string, pos: [number, number, number], extra: Partial<Connectable> = {}): Connectable {
  const r = node(name);
  r.position.set(pos[0], pos[1], pos[2]);
  r.updateMatrixWorld(true);
  return { root: r, kind, connectionType: 'material-flow', autoConnect: { enabled: true, maxDistance: 1.0 }, ...extra };
}

const dist = (cs: Connectable[], opts: { maxDistance?: number } = {}): ConnectionLink[] =>
  resolveConnections(cs, { registry: null, ...opts });

describe('distance stage — typed fallback (ported cases)', () => {
  it('connects a source to the nearest conveyor in range (F1)', () => {
    const src = inst('Source', 'source', [0, 0, 0]);
    const conv = inst('Conveyor', 'conveyor', [0.5, 0, 0]);
    const links = dist([src, conv]);
    expect(edgeNames(links)).toEqual(['Source>Conveyor:distance']);
    expect(links[0].distance).toBeCloseTo(0.5, 9);
  });

  it('respects the max distance (F7)', () => {
    expect(dist([inst('Source', 'source', [0, 0, 0]), inst('Conveyor', 'conveyor', [5, 0, 0])])).toEqual([]);
  });

  it('picks the nearest of several candidates', () => {
    const src = inst('Source', 'source', [0, 0, 0]);
    const near = inst('Near', 'conveyor', [0.3, 0, 0]);
    const far = inst('Far', 'conveyor', [0.9, 0, 0]);
    expect(successors(dist([src, far, near])).Source).toEqual(['Near']);
  });

  it('does not touch instances already wired (explicit links, F4)', () => {
    const other = inst('Other', 'sink', [0.3, 0, 0]);
    const src = inst('Source', 'source', [0, 0, 0], { existingNext: [other.root] });
    expect(dist([src, other])).toEqual([]);
  });

  it('never self-loops and never targets a source as input', () => {
    expect(dist([inst('Source', 'source', [0, 0, 0])])).toEqual([]);
    const s1 = inst('S1', 'source', [0, 0, 0]);
    const s2 = inst('S2', 'source', [0.2, 0, 0]);
    expect(dist([s1, s2])).toEqual([]);
  });

  it('only connects matching connectionType (typed)', () => {
    const ctrl = inst('Ctrl', 'source', [0, 0, 0], { connectionType: 'control' });
    const conv = inst('Conveyor', 'conveyor', [0.3, 0, 0]);
    expect(dist([ctrl, conv])).toEqual([]);
  });

  it('subType must match when both set', () => {
    const a = inst('A', 'source', [0, 0, 0], { subType: 'pallet' });
    const b = inst('B', 'conveyor', [0.3, 0, 0], { subType: 'box' });
    const d = inst('D', 'conveyor', [0.6, 0, 0]);
    expect(successors(dist([a, b, d])).A).toEqual(['D']);
  });

  it('skips instances with autoConnect disabled', () => {
    const src = inst('Source', 'source', [0, 0, 0], { autoConnect: { enabled: false, maxDistance: 1 } });
    expect(dist([src, inst('Conveyor', 'conveyor', [0.3, 0, 0])])).toEqual([]);
  });

  it('equal distances tie-break by uuid, independent of input order', () => {
    const src = inst('Source', 'source', [0, 0, 0]);
    const x = inst('X', 'conveyor', [0.4, 0, 0]);
    const y = inst('Y', 'conveyor', [-0.4, 0, 0]);
    x.root.uuid = 'z-later';
    y.root.uuid = 'a-first';
    expect(successors(dist([src, x, y])).Source).toEqual(['Y']);
    expect(successors(dist([y, x, src])).Source).toEqual(['Y']);
  });

  it('typed radius: ≤ 0 means 1.0 m; a global override wins', () => {
    const src = inst('Source', 'source', [0, 0, 0], { autoConnect: { enabled: true, maxDistance: 0 } });
    const conv = inst('Conveyor', 'conveyor', [1.5, 0, 0]);
    expect(dist([src, conv])).toEqual([]);
    expect(edgeNames(dist([src, conv], { maxDistance: 2 }))).toEqual(['Source>Conveyor:distance']);
  });

  it('contained: a source centre INSIDE the belt AABB scores distance 0', () => {
    const belt = node('Belt');
    belt.add(new Mesh(new BoxGeometry(1, 0.1, 0.4)));
    belt.updateMatrixWorld(true);
    const src = inst('Pallet', 'source', [0.2, 0, 0]);
    const links = dist([src, { root: belt, kind: 'conveyor', connectionType: 'material-flow' }]);
    expect(links).toHaveLength(1);
    expect(links[0].distance).toBe(0);
    expect(links[0].contained).toBe(true);
    // Next to the belt (not inside): a link, but not contained.
    const beside = inst('Beside', 'source', [0.8, 0, 0]);
    const l2 = dist([beside, { root: belt, kind: 'conveyor', connectionType: 'material-flow' }]);
    expect(l2[0].contained).toBe(false);
    expect(l2[0].distance).toBeGreaterThan(0);
  });

  it('snap precedence: a connectable with a snap downstream gets no distance link', () => {
    const a = conveyorRoot('A', 0);
    const b = conveyorRoot('B', 1);
    const sink = root('Sink', 1.7);
    refresh(a, b, sink);
    const reg = buildConnectionRegistry([a, b, sink]);
    const r = resolveConnectionsDetailed([c(a, 'conveyor'), c(b, 'conveyor'), c(sink, 'sink')], { registry: reg });
    expect(r.distanceLinks).toBe(1);
    expect(successors(r.links)).toEqual({ A: ['B'], B: ['Sink'] });
  });
});

describe('distance stage — legacy connectables (native DES*, Gate R1 #8)', () => {
  const legacy = (name: string, kind: string, x: number, extra: Partial<Connectable> = {}): Connectable => {
    const r = node(name);
    r.position.set(x, 0, 0);
    r.updateMatrixWorld(true);
    return {
      root: r, kind, connectionType: 'material-flow', radiusPolicy: 'legacy',
      autoConnect: { enabled: true, maxDistance: 0 },
      portPositions: { out: new Vector3(x + 0.5, 0, 0), in: new Vector3(x - 0.5, 0, 0) },
      acceptsInputs: kind !== 'source',
      emitsOutputs: true,
      ...extra,
    };
  };

  it('maxDistance ≤ 0 is UNBOUNDED: Source → Sink over more than 2 m', () => {
    const src = legacy('Src', 'source', 0);
    const snk = legacy('Snk', 'sink', 3.5);
    const links = dist([src, snk]);
    expect(successors(links).Src).toEqual(['Snk']);
    expect(links[0].distance).toBeCloseTo(2.5, 9); // OUT (0.5) → IN (3.0)
    expect(links[0].contained).toBe(false);
  });

  it('a positive legacy radius filters', () => {
    const src = legacy('Src', 'source', 0, { autoConnect: { enabled: true, maxDistance: 1 } });
    const snk = legacy('Snk', 'sink', 3.5);
    expect(successors(dist([src, snk])).Src).toBeUndefined();
  });

  it('OUT → IN metric and acceptsInputs (a source is never a target)', () => {
    const src = legacy('Src', 'source', 0);
    const c1 = legacy('C1', 'conveyor', 1.2);
    const c2 = legacy('C2', 'conveyor', 2.4);
    const s = successors(dist([c2, src, c1]));
    expect(s.Src).toEqual(['C1']);
    expect(s.C1).toEqual(['C2']);
    expect(Object.values(s).flat()).not.toContain('Src');
  });

  it('explicit links are kept: a component with existingNext gets nothing new', () => {
    const src = legacy('Src', 'source', 0);
    const c1 = legacy('C1', 'conveyor', 1.0);
    const c2 = legacy('C2', 'conveyor', 1.0, { existingNext: [] });
    const withLinks = { ...src, existingNext: [c2.root, c1.root] };
    expect(successors(dist([withLinks, c1, c2])).Src).toBeUndefined();
  });
});

// ─── Registry access ────────────────────────────────────────────────────────

describe('getConnectionRegistry — one access point (Gate R1 #3)', () => {
  it('returns the live plugin registry unchanged when the plugin exists (even null)', () => {
    const live = new SnapPointRegistry();
    expect(getConnectionRegistry({ getPlugin: (id) => (id === 'snap-point' ? { getRegistry: () => live } : undefined) })).toBe(live);
    expect(getConnectionRegistry({ getPlugin: (id) => (id === 'snap-point' ? { getRegistry: () => null } : undefined) })).toBeNull();
  });

  it('headless: the attached per-binding registry, until detached', () => {
    const host = { getPlugin: () => undefined };
    expect(getConnectionRegistry(host)).toBeNull();
    const a = conveyorRoot('A', 0);
    const b = conveyorRoot('B', 1);
    refresh(a, b);
    const reg = attachHeadlessConnectionRegistry(host, [a, b]);
    expect(getConnectionRegistry(host)).toBe(reg);
    // Scanned PER OWNER: each snap belongs to its instance root, so they paired.
    expect(new Set(reg.getAll().map((s) => s.ownerRoot))).toEqual(new Set([a, b]));
    expect(reg.getAll().filter((s) => s.pairedSnapId)).toHaveLength(2);
    detachHeadlessConnectionRegistry(host);
    expect(getConnectionRegistry(host)).toBeNull();
  });

  it('pairs ports on a drive in the drive HOME pose, then restores the pose', () => {
    const tt = root('Turntable', 0);
    const platform = node('Drive-Rot-Y');
    tt.add(platform);
    addSnap(platform, 'Snap-XP-convroll', 0.5);
    const out = conveyorRoot('Out', 1);
    platform.rotation.y = Math.PI / 2; // left rotated: port is now at z = -0.5
    refresh(tt, out);
    const rotated = platform.quaternion.clone();
    const drive = {
      node: platform,
      getHomeLocalPosition: (o: Vector3) => o.set(0, 0, 0),
      getHomeLocalQuaternion: (o: Quaternion) => o.identity(),
    };
    const without = buildConnectionRegistry([tt, out]);
    expect(without.getAll().some((s) => s.pairedSnapId)).toBe(false);
    const withHome = buildConnectionRegistry([tt, out], { drives: [drive] });
    expect(withHome.getAll().filter((s) => s.pairedSnapId)).toHaveLength(2);
    expect(platform.quaternion.equals(rotated)).toBe(true);
  });

  // ── plan-633 Phase 2: the binding's acquire / release ──

  it('acquire with the plugin present: the live registry, nothing attached', () => {
    const live = new SnapPointRegistry();
    const host = { getPlugin: (id: string) => (id === 'snap-point' ? { getRegistry: () => live } : undefined) };
    expect(hasSnapPointPlugin(host)).toBe(true);
    const a = conveyorRoot('A', 0);
    refresh(a);
    const got = acquireBindingConnectionRegistry(host, [a]);
    expect(got.headless).toBe(false);
    expect(got.registry).toBe(live);
    expect(live.getAll()).toHaveLength(0); // the planner registry is never scanned into
  });

  it('acquire headless: owners deduplicated, a nested owner keeps its own snaps', () => {
    const host = { getPlugin: () => undefined };
    expect(hasSnapPointPlugin(host)).toBe(false);
    const outer = conveyorRoot('Outer', 0);
    const inner = conveyorRoot('Inner', 3);
    outer.add(inner);
    refresh(outer);
    // Bind order = traversal order: the enclosing owner comes first. Without the
    // deepest-first scan it would claim the inner snaps.
    const got = acquireBindingConnectionRegistry(host, [outer, inner, outer]);
    expect(got.headless).toBe(true);
    expect(got.registry).not.toBeNull();
    expect(getConnectionRegistry(host)).toBe(got.registry);
    const reg = got.registry!;
    expect(reg.getByOwnerRoot(inner)).toHaveLength(2);
    expect(reg.getByOwnerRoot(outer)).toHaveLength(2);
    detachHeadlessConnectionRegistry(host, got.registry);
    expect(getConnectionRegistry(host)).toBeNull();
  });

  it('release only drops the registry it was given (a newer binding keeps its own)', () => {
    const host = { getPlugin: () => undefined };
    const a = conveyorRoot('A', 0);
    refresh(a);
    const first = acquireBindingConnectionRegistry(host, [a]);
    const second = acquireBindingConnectionRegistry(host, [a]);
    expect(second.registry).not.toBe(first.registry);
    detachHeadlessConnectionRegistry(host, first.registry);
    expect(getConnectionRegistry(host)).toBe(second.registry);
    detachHeadlessConnectionRegistry(host, second.registry);
    expect(getConnectionRegistry(host)).toBeNull();
  });
});

// ─── Path-link tolerance (Gate R1 #7, R2 note) ──────────────────────────────

function straight(id: string, from: [number, number, number], to: [number, number, number]) {
  return parsePathExtras({ type: 'Path', id, segments: [{ kind: 'line', from, to }] }, id)!;
}

describe('PATH_LINK_TOLERANCE — one criterion for writing and checking', () => {
  it('is 5 mm / 2°', () => {
    expect(PATH_LINK_TOLERANCE).toEqual({ distM: 0.005, tangentDeg: 2 });
    expect(Object.isFrozen(PATH_LINK_TOLERANCE)).toBe(true);
  });

  const linkAt = (gapM: number, angleDeg = 0): boolean => {
    const a = straight('A', [0, 0, 0], [1, 0, 0]);
    const rad = (angleDeg * Math.PI) / 180;
    const sx = 1 + gapM;
    const b = straight('B', [sx, 0, 0], [sx + Math.cos(rad), 0, Math.sin(rad)]);
    const ea = getPathEndpoints(a)!;
    const eb = getPathEndpoints(b)!;
    return isPathLink(ea.end.position, ea.end.tangent, eb.start.position, eb.start.tangent);
  };

  it('distance: 4 mm links, exactly 5 mm links, 6 mm and 29 mm do not', () => {
    expect(linkAt(0.004)).toBe(true);
    expect(linkAt(0.005)).toBe(true);
    expect(linkAt(0.006)).toBe(false);
    expect(linkAt(0.029)).toBe(false);
  });

  it('tangent: exactly 2° links, 2.5° does not', () => {
    expect(linkAt(0, 1)).toBe(true);
    expect(linkAt(0, 2)).toBe(true);
    expect(linkAt(0, 2.5)).toBe(false);
  });

  it('measures the travel TANGENTS, not the opposed outward vectors', () => {
    const a = straight('A', [0, 0, 0], [1, 0, 0]);
    const b = straight('B', [1, 0, 0], [2, 0, 0]);
    const ea = getPathEndpoints(a)!;
    const eb = getPathEndpoints(b)!;
    expect(tangentAngleDeg(ea.end.tangent, eb.start.tangent)).toBeCloseTo(0, 9);
    expect(tangentAngleDeg(ea.end.outward, eb.start.outward)).toBeCloseTo(180, 9);
    expect(isPathLink(ea.end.position, ea.end.tangent, eb.start.position, eb.start.tangent)).toBe(true);
  });

  it('direction matters: START → END of the same pair is no link', () => {
    const a = straight('A', [0, 0, 0], [1, 0, 0]);
    const b = straight('B', [1, 0, 0], [2, 0, 0]);
    const ea = getPathEndpoints(a)!;
    const eb = getPathEndpoints(b)!;
    expect(isPathLink(eb.end.position, eb.end.tangent, ea.start.position, ea.start.tangent)).toBe(false);
  });
});
